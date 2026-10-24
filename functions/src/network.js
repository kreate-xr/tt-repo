// Which "network" a request comes from, for the shared trial clock and the
// new-trial cap. Pure, so the grouping rules are the rules under test.
//
// IPv4: the whole address — a home router shows one address to the world.
// IPv6: the first 64 bits. A home gets a /64 (or larger) and every device in
// it picks its own address there, rotating it daily for privacy, so the full
// address would hand a private window a fresh trial by tomorrow.

import { isIP } from 'node:net';

/** @returns {string} 'v4:a.b.c.d' | 'v6:xxxx:xxxx:xxxx:xxxx' | '' when unusable */
export function networkKey(raw) {
  let ip = String(raw || '').trim();
  if (ip.startsWith('[')) ip = ip.slice(1, ip.indexOf(']') > 0 ? ip.indexOf(']') : undefined);
  const zone = ip.indexOf('%');
  if (zone >= 0) ip = ip.slice(0, zone);
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(':'));

  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) ip = mapped[1];

  const kind = isIP(ip);
  if (kind === 4) return `v4:${ip}`;
  if (kind === 6) return `v6:${expandV6(ip).slice(0, 4).join(':')}`;
  return '';
}

function expandV6(ip) {
  let head = ip;
  let tail = '';
  const gap = ip.indexOf('::');
  if (gap >= 0) {
    head = ip.slice(0, gap);
    tail = ip.slice(gap + 2);
  }
  const toGroups = (part) => (part ? part.split(':') : []).flatMap((g) => {
    if (!g.includes('.')) return [g];
    const [a, b, c, d] = g.split('.').map(Number); // embedded IPv4 tail
    return [((a << 8) | b).toString(16), ((c << 8) | d).toString(16)];
  });
  const h = toGroups(head);
  const t = toGroups(tail);
  const groups = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return groups.map((g) => g.toLowerCase().padStart(4, '0'));
}
