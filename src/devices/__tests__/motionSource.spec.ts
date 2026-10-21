import { describe, it, expect, vi } from 'vitest';
import { Blink } from '../index.js';
import { DEFAULT_OPTIONS } from '../../lib/config.js';
import type { BlinkAuthClient } from '../../lib/auth.js';
import type { MediaEntry } from '../../lib/api.js';
import type { Logger } from 'homebridge';

const secondsAgo = (s: number) => new Date(Date.now() - s * 1000).toISOString();

function mediaEntry(entry: Partial<MediaEntry>): MediaEntry {
  return {
    id: 1,
    created_at: secondsAgo(5),
    updated_at: secondsAgo(5),
    device_id: 42,
    network_id: 100,
    device: 'camera',
    thumbnail: '/media/thumb.jpg',
    ...entry,
  };
}

function makeDevice(type: string) {
  return {
    id: 42,
    network_id: 100,
    name: 'Patio',
    serial: 'TEST0042',
    fw_version: '1.0.0',
    type,
    enabled: true,
    thumbnail: '',
    status: 'online',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

/**
 * Drives the REAL motion selection (getMergedMedia + getCameraLastMotion +
 * BlinkCamera.getMotionDetected) against a stubbed API on an armed network.
 */
async function makeArmedBlink(
  media: MediaEntry[],
  devices: { cameras?: unknown[]; doorbells?: unknown[] } = {
    cameras: [makeDevice('catalina')],
  }
) {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
  const blink = new Blink(
    { isAuthenticated: false } as unknown as BlinkAuthClient,
    log,
    30,
    15,
    3600,
    { ...DEFAULT_OPTIONS, localStorageMotion: 'never' }
  );
  const homescreen = {
    networks: [{ id: 100, name: 'Blink Home', armed: true }],
    sync_modules: [{ id: 555, network_id: 100, status: 'online' }],
    cameras: devices.cameras ?? [],
    owls: [],
    doorbells: devices.doorbells ?? [],
    doorbell_buttons: [],
    sirens: [],
  };
  const api = {
    getAccountHomescreen: vi.fn(async () => structuredClone(homescreen)),
    getMediaChange: vi.fn(async () => ({ media: structuredClone(media) })),
    probeDoorbellConfig: vi.fn().mockResolvedValue(undefined),
    enableCameraMotion: vi.fn().mockResolvedValue(undefined),
    disableCameraMotion: vi.fn().mockResolvedValue(undefined),
    enableDoorbellMotion: vi.fn().mockResolvedValue(undefined),
    disableDoorbellMotion: vi.fn().mockResolvedValue(undefined),
    lock: vi.fn((_name: string, fn: () => Promise<unknown>) => fn()),
    command: vi.fn((_networkID: number, fn: () => Promise<unknown>) => fn()),
  };
  Object.defineProperty(blink, 'api', { value: api });
  await blink.refreshData();
  // Armed well before any of the clips below.
  blink.networks.get(100)!.armedAt = Date.now() - 60 * 60 * 1000;
  return blink;
}

describe('motion selection ignores non-motion media sources', () => {
  // Blink's Photo Capture feature periodically posts a summary clip of the
  // camera's scheduled snapshots. Its media entry has source "snapshot"; it
  // is not a motion event and must not trip motion (and with it the alarm).
  it('does not fire when the newest entry is a snapshot summary', async () => {
    const blink = await makeArmedBlink([
      mediaEntry({ source: 'snapshot', created_at: secondsAgo(5) }),
    ]);
    await expect(blink.cameras.get(42)!.getMotionDetected()).resolves.toBe(
      false
    );
    await expect(blink.getCameraLastMotion(100, 42)).resolves.toBeUndefined();
  });

  // The filter must pick the newest MOTION entry, not just bail out when
  // the newest entry is a snapshot: a snapshot posted moments after a real
  // motion clip must not hide that clip.
  it('still fires for a motion clip that is older than a newer snapshot', async () => {
    const blink = await makeArmedBlink([
      mediaEntry({ id: 2, source: 'snapshot', created_at: secondsAgo(5) }),
      mediaEntry({ id: 1, source: 'pir', created_at: secondsAgo(20) }),
    ]);
    const entry = await blink.getCameraLastMotion(100, 42);
    expect(entry?.id).toBe(1);
    expect(entry?.source).toBe('pir');
    await expect(blink.cameras.get(42)!.getMotionDetected()).resolves.toBe(
      true
    );
  });

  it('still fires for a plain motion clip', async () => {
    const blink = await makeArmedBlink([
      mediaEntry({ source: 'pir', created_at: secondsAgo(5) }),
    ]);
    await expect(blink.cameras.get(42)!.getMotionDetected()).resolves.toBe(
      true
    );
  });

  // Older firmware omits the source field; such entries stay motion.
  it('still fires for a clip with no source field', async () => {
    const blink = await makeArmedBlink([
      mediaEntry({ created_at: secondsAgo(5) }),
    ]);
    await expect(blink.cameras.get(42)!.getMotionDetected()).resolves.toBe(
      true
    );
  });

  // Thumbnails still use the newest media of any kind: a snapshot entry's
  // thumbnail is a genuinely fresh image of the camera.
  it('still offers a snapshot entry as the newest thumbnail', async () => {
    const blink = await makeArmedBlink([
      mediaEntry({
        source: 'snapshot',
        created_at: secondsAgo(5),
        thumbnail: '/media/snapshot-summary.jpg',
      }),
    ]);
    const camera = blink.cameras.get(42)!;
    camera.data = { ...camera.data, updated_at: new Date().toISOString() };
    camera.thumbnailCreatedAt = Date.now() - 60 * 60 * 1000;
    await expect(blink.getCameraLastThumbnail(100, 42)).resolves.toBe(
      '/media/snapshot-summary.jpg'
    );
  });

  it('leaves doorbell press detection unaffected by a newer snapshot', async () => {
    const press = new Date(Date.now() - 2000).toISOString();
    const blink = await makeArmedBlink(
      [
        mediaEntry({
          id: 2,
          device: 'lotus',
          source: 'snapshot',
          created_at: secondsAgo(1),
        }),
        mediaEntry({
          id: 1,
          device: 'lotus',
          source: 'button_press',
          created_at: press,
        }),
      ],
      { doorbells: [makeDevice('lotus')] }
    );
    const pressEntry = await blink.getCameraLastPress(100, 42);
    expect(pressEntry?.id).toBe(1);

    const doorbell = blink.doorbells.get(42)!;
    doorbell.lastDoorbellPress = Date.now() - 60 * 1000;
    const onPress = vi.fn();
    doorbell.onPress = onPress;
    await expect(doorbell.checkForPress()).resolves.toBe(true);
    expect(onPress).toHaveBeenCalledOnce();
  });
});

// Real case, 2026-10-21: a Home automation turned the Room camera off at
// 23:00 (camera disable endpoint), the system was armed at 00:00, and at
// 00:14 Blink still recorded a cv_motion clip for Room. The plugin fired
// motion and HomeKit's security system went to triggered. A camera that is
// off in HomeKit must never fire motion, whatever Blink records.
describe('motion is suppressed while the camera is off', () => {
  it('does not fire after HomeKit turned the camera off, even if Blink still reports it enabled', async () => {
    const blink = await makeArmedBlink([
      mediaEntry({ source: 'cv_motion', created_at: secondsAgo(5) }),
    ]);
    const camera = blink.cameras.get(42)!;
    await camera.setEnabled(false);
    expect(blink.api.disableCameraMotion).toHaveBeenCalledWith(100, 42);
    // The homescreen stub keeps reporting enabled: true after the command.
    expect(camera.enabled).toBe(true);
    await expect(camera.getMotionDetected()).resolves.toBe(false);
    expect(blink.log.debug).toHaveBeenCalledWith(
      'Blink Patio motion: suppressed: camera off (HomeKit=false, Blink=true)'
    );
    // The switch shows the camera off, so Home never reads ON while motion
    // is suppressed.
    expect(camera.getEnabled()).toBe(false);
  });

  it('keeps no override when turning the camera off fails', async () => {
    const blink = await makeArmedBlink([
      mediaEntry({ source: 'cv_motion', created_at: secondsAgo(5) }),
    ]);
    vi.mocked(blink.api.disableCameraMotion).mockRejectedValueOnce(
      new Error('boom')
    );
    const camera = blink.cameras.get(42)!;
    await expect(camera.setEnabled(false)).rejects.toThrow('boom');
    expect(camera.getEnabled()).toBe(true);
    await expect(camera.getMotionDetected()).resolves.toBe(true);
  });

  it('does not fire for a doorbell HomeKit turned off', async () => {
    const blink = await makeArmedBlink(
      [
        mediaEntry({
          device: 'lotus',
          source: 'cv_motion',
          created_at: secondsAgo(5),
        }),
      ],
      { doorbells: [makeDevice('lotus')] }
    );
    const doorbell = blink.doorbells.get(42)!;
    await expect(doorbell.getMotionDetected()).resolves.toBe(true);
    await doorbell.setEnabled(false);
    expect(blink.api.disableDoorbellMotion).toHaveBeenCalledWith(100, 42);
    await expect(doorbell.getMotionDetected()).resolves.toBe(false);
  });

  it('does not fire when Blink reports the camera disabled', async () => {
    const blink = await makeArmedBlink(
      [mediaEntry({ source: 'cv_motion', created_at: secondsAgo(5) })],
      { cameras: [{ ...makeDevice('catalina'), enabled: false }] }
    );
    await expect(blink.cameras.get(42)!.getMotionDetected()).resolves.toBe(
      false
    );
  });

  it('fires again once HomeKit turns the camera back on', async () => {
    const blink = await makeArmedBlink([
      mediaEntry({ source: 'cv_motion', created_at: secondsAgo(5) }),
    ]);
    const camera = blink.cameras.get(42)!;
    await camera.setEnabled(false);
    // Blink already reports enabled, so no API call is sent; the HomeKit
    // state must still be cleared.
    await camera.setEnabled(true);
    await expect(camera.getMotionDetected()).resolves.toBe(true);
  });

  it('fires as before for a camera never set from HomeKit', async () => {
    const blink = await makeArmedBlink([
      mediaEntry({ source: 'cv_motion', created_at: secondsAgo(5) }),
    ]);
    await expect(blink.cameras.get(42)!.getMotionDetected()).resolves.toBe(
      true
    );
  });

  it('logs Blink enabled flag changes once per transition', async () => {
    const blink = await makeArmedBlink([]);
    const camera = blink.cameras.get(42)!;
    const debug = vi.mocked(blink.log.debug);
    const line = 'Blink Patio enabled (Blink): true -> false';
    camera.data = { ...camera.data, enabled: false };
    camera.data = { ...camera.data, enabled: false };
    expect(debug.mock.calls.filter(([msg]) => msg === line)).toHaveLength(1);
    camera.data = { ...camera.data, enabled: true };
    expect(debug).toHaveBeenCalledWith(
      'Blink Patio enabled (Blink): false -> true'
    );
  });
});
