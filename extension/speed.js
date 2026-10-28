// ClipAtlas playback speed: runs only inside TikTok's embedded player
// (https://www.tiktok.com/player/...), and only when ClipAtlas asked for a
// speed in the player's address (#clipatlas-speed=1.5, added by auto-review).
// It sets the speed of the player's video, the same as the player's own gear
// menu does. It reads nothing from the page and sends nothing anywhere.
(() => {
  const asked = /(?:^#|[#&])clipatlas-speed=(\d(?:\.\d+)?)/.exec(location.hash);
  if (!asked) return;
  const speed = Math.min(2, Math.max(1, Number(asked[1]) || 1));
  if (speed === 1) return;

  const seen = new WeakSet();
  const resets = new WeakMap();   // how often the player put a video back to another speed
  const apply = video => {
    if (Math.abs(video.playbackRate - speed) < 0.01) return;
    const n = (resets.get(video) || 0) + 1;
    resets.set(video, n);
    if (n > 40) return;   // the player keeps changing it back: stop fighting it
    video.preservesPitch = true;
    video.playbackRate = speed;
  };
  const hook = video => {
    if (!(video instanceof HTMLVideoElement) || seen.has(video)) return;
    seen.add(video);
    for (const type of ['loadedmetadata', 'play', 'playing', 'ratechange']) video.addEventListener(type, () => apply(video));
    apply(video);
  };
  // Media events do not bubble, but they pass through the document on the way down.
  for (const type of ['loadedmetadata', 'play', 'playing']) document.addEventListener(type, e => hook(e.target), true);
  const scan = () => document.querySelectorAll('video').forEach(video => { hook(video); apply(video); });
  new MutationObserver(scan).observe(document, { childList: true, subtree: true });
  setInterval(scan, 1000);
  scan();
})();
