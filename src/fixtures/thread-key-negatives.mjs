// B4: the lab's negative key list (P2-B4-0 E1, plan §3.2) as tids. Every layer must refuse each of these (never normalise them).
const HEX = "0123456789abcdef0123456789abcdef";
// The lab's negative list (P2-B4-0 E1, plan §3.2), as a tid
export const BAD_TIDS = [
  HEX.toUpperCase(), "0123456789ABCDEF0123456789abcdef", HEX.slice(0, 31), `${HEX}0`, `${HEX}:extra`, `${HEX}:thread:1`, `${HEX}:subagent:x`,
  `${HEX.slice(0, 16)}::${HEX.slice(0, 14)}`, `${HEX.slice(0, 31)}/`, `../${HEX.slice(0, 29)}`, `${HEX.slice(0, 29)}%2F`, ` ${HEX.slice(1)}`, `${HEX.slice(1)} `,
  `${HEX}\n`, `\n${HEX}`, `café${HEX.slice(5)}`, `incognito-${HEX.slice(10)}`, `agent:main:${HEX}`, `agent:main:app:owner:${HEX}`, `app:owner:${HEX}`,
  "main", "agent:main:main", "agent:main:whatsapp:direct:+966500000001", "LEGACY", "Legacy", "legacy ", " legacy", "legacy\n", "",
  `${HEX.slice(0, 31)}g`, `${HEX.slice(0, 31)}٠`, undefined, null, 0, 123, [HEX], { tid: HEX },
];

