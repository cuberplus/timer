import { useEffect } from 'react';

export function useScreenWakeLock() {
  useEffect(() => {
    if (!navigator.wakeLock) return;

    let lock: WakeLockSentinel | null = null;
    let pending = false;
    let disposed = false;
    const release = (sentinel: WakeLockSentinel) => { void sentinel.release().catch(() => {}); };

    async function acquire() {
      if (disposed || pending || lock || document.visibilityState !== 'visible') return;
      pending = true;
      try {
        const sentinel = await navigator.wakeLock.request('screen');
        if (disposed || document.visibilityState !== 'visible') {
          release(sentinel);
          return;
        }
        if (!sentinel.released) {
          lock = sentinel;
          sentinel.addEventListener('release', () => { if (lock === sentinel) lock = null; }, { once: true });
        }
      } catch {
        // Battery-saving settings or browser permissions can deny the request.
      } finally {
        pending = false;
      }
    }

    function visibilityChanged() {
      if (document.visibilityState === 'visible') void acquire();
      else if (lock) {
        const sentinel = lock;
        lock = null;
        release(sentinel);
      }
    }

    void acquire();
    document.addEventListener('visibilitychange', visibilityChanged);
    document.addEventListener('pointerdown', acquire);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', visibilityChanged);
      document.removeEventListener('pointerdown', acquire);
      if (lock) release(lock);
    };
  }, []);
}
