/* What to answer Electron's select-bluetooth-device with. Pure, so it is testable
   without Electron or a strip.

   The renderer always scans with the profile's filters, so `devices` holds only
   candidates for the strip being connected. The iStrip advertises no name at all
   (Electron reports "Unknown or Unsupported Device (MAC)"), which is why a strip is
   remembered by its address, per profile, and never by name.

   → { pick: deviceId }   answer now, no UI
     { ask: [{id,name}] } several candidates and none remembered — let the user choose
     { wait: true }       nothing decisive yet; the scan is still reporting */
export function decide({ devices, remembered, firstSeenAt, now, settleMs }) {
  if (remembered) {
    return devices.some(d => d.deviceId === remembered)
      ? { pick: remembered }
      : { wait: true };                  // the grace timer gives up if it never shows
  }
  if (!devices.length) return { wait: true };
  // Give the scan a moment to report every candidate before choosing on our own.
  if (firstSeenAt == null || now - firstSeenAt < settleMs) return { wait: true };
  if (devices.length === 1) return { pick: devices[0].deviceId };
  return { ask: devices.map(d => ({ id: d.deviceId, name: d.deviceName || d.deviceId })) };
}
