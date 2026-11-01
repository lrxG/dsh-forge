/* 内联图标：统一 24 视框、1.6 描边，跟随 currentColor。
   不引第三方图标库：产物小，也不会跟宿主的图标风格打架。 */

const DF_ICONS = {
  shield: ['M12 3.2l7 2.9v5.1c0 4.4-2.9 7.8-7 9.6-4.1-1.8-7-5.2-7-9.6V6.1l7-2.9z'],
  grid: ['M4 4h7v7H4z', 'M13 4h7v7h-7z', 'M4 13h7v7H4z', 'M13 13h7v7h-7z'],
  server: ['M4 5h16v5H4z', 'M4 14h16v5H4z', 'M7.5 7.5h.01', 'M7.5 16.5h.01'],
  bug: ['M9 5.5a3 3 0 0 1 6 0', 'M7 9h10v5a5 5 0 0 1-10 0z', 'M12 9v10', 'M4 12h3', 'M17 12h3', 'M5.5 6.5L8 9', 'M18.5 6.5L16 9', 'M5.5 18.5L8 16', 'M18.5 18.5L16 16'],
  link: ['M10.5 13.5a4 4 0 0 0 5.7 0l2.3-2.3a4 4 0 1 0-5.7-5.7l-1 1', 'M13.5 10.5a4 4 0 0 0-5.7 0l-2.3 2.3a4 4 0 1 0 5.7 5.7l1-1'],
  route: ['M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z', 'M18 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4z', 'M8 17h5a4 4 0 0 0 4-4V9'],
  list: ['M8 6h12', 'M8 12h12', 'M8 18h12', 'M4 6h.01', 'M4 12h.01', 'M4 18h.01'],
  book: ['M5 4h9a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z', 'M17 7h2v13H8'],
  spark: ['M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z', 'M18.5 15.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z'],
  cloud: ['M7 18a4 4 0 0 1 0-8 5.5 5.5 0 0 1 10.4 1.4A3.4 3.4 0 0 1 17.5 18z'],
  trash: ['M4 7h16', 'M9.5 7V4.8h5V7', 'M6.5 7l1 12.2h9L17.5 7', 'M10 11v5', 'M14 11v5'],
  users: ['M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z', 'M3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5', 'M16 4.5a3.5 3.5 0 0 1 0 7', 'M17.5 14.8c2.1.7 3.5 2.4 3.5 5.2'],
  sliders: ['M4 7h10', 'M18 7h2', 'M4 17h4', 'M12 17h8', 'M16 4.5v5', 'M8 14.5v5'],
  prompt: ['M4 5h16v11H9l-5 4z', 'M8 9h8', 'M8 12.5h5'],
  wrench: ['M15.5 4.5a4.5 4.5 0 0 0-5.9 5.6L4 15.7 8.3 20l5.6-5.6a4.5 4.5 0 0 0 5.6-5.9l-2.9 2.9-2.9-2.9z'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M20 20l-3.6-3.6'],
  refresh: ['M20 11a8 8 0 1 0-2.3 5.7', 'M20 4.5V11h-6.5'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  max: ['M5 5h14v14H5z'],
  restore: ['M8 8h11v11H8z', 'M5 16V5h11'],
  plus: ['M12 5v14', 'M5 12h14'],
  chevron: ['M8 10l4 4 4-4'],
  chevronRight: ['M10 8l4 4-4 4'],
  copy: ['M9 9h10v10H9z', 'M15 9V5H5v10h4'],
  external: ['M14 4h6v6', 'M20 4l-8 8', 'M18 14v5H5V6h5'],
  filter: ['M4 5h16l-6 7v6l-4 2v-8z'],
  sort: ['M8 5v14', 'M5 8l3-3 3 3', 'M16 19V5', 'M13 16l3 3 3-3'],
  play: ['M8 5l11 7-11 7z'],
  check: ['M5 12.5l4.5 4.5L19 7'],
  alert: ['M12 4l9 16H3z', 'M12 10v4.5', 'M12 17.5h.01'],
  info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 11v5', 'M12 7.5h.01'],
  key: ['M14.5 9.5a3.5 3.5 0 1 1-3-3.4', 'M13 11l7 7', 'M17 15l2-2', 'M19 17l2-2'],
  terminal: ['M4 6h16v12H4z', 'M7 10l2.5 2L7 14', 'M12.5 14.5H17'],
  eye: ['M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7.5V12l3 2'],
  target: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9z', 'M12 12h.01'],
  more: ['M6 12h.01', 'M12 12h.01', 'M18 12h.01'],
  download: ['M12 4v10', 'M8 11l4 4 4-4', 'M5 19h14'],
  upload: ['M12 20V10', 'M7 15l5-5 5 5', 'M5 4h14'],
  folder: ['M4 7h6l2 2h8v10H4z'],
  lock: ['M6 11h12v9H6z', 'M9 11V8a3 3 0 0 1 6 0v3'],
  bolt: ['M13 3L5 14h6l-1 7 8-11h-6z'],
  db: ['M12 6.5c4.4 0 8-1.1 8-2.5S16.4 1.5 12 1.5 4 2.6 4 4s3.6 2.5 8 2.5z', 'M4 4v7c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5V4', 'M4 11v7c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-7'],
  crosshair: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 3v4', 'M12 17v4', 'M3 12h4', 'M17 12h4'],
  pause: ['M9 5v14', 'M15 5v14'],
  arrowRight: ['M5 12h13', 'M13 7l5 5-5 5'],
  arrowUp: ['M12 19V5', 'M6 11l6-6 6 6'],
  arrowDown: ['M12 5v14', 'M6 13l6 6 6-6'],
  minus: ['M5 12h14'],
  star: ['M12 4l2.4 5 5.6.8-4 4 1 5.6-5-2.7-5 2.7 1-5.6-4-4 5.6-.8z'],
  layers: ['M12 3l9 5-9 5-9-5z', 'M3 13l9 5 9-5', 'M3 17.5l9 5 9-5'],
  panelLeft: ['M4 5h16v14H4z', 'M9.5 5v14'],
  focus: ['M9 4H4v5', 'M15 4h5v5', 'M20 15v5h-5', 'M4 15v5h5'],
  fileText: ['M6 3h8l4 4v14H6z', 'M14 3v4h4', 'M9 12h6', 'M9 16h6'],
  image: ['M4 5h16v14H4z', 'M8.5 11a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3', 'M4 17l5-5 4 4 3-3 4 4'],
}

/**
 * 取图标。
 * @param {string} name - DF_ICONS 的键。
 * @param {number} [size] - 像素，默认 16。
 * @param {number} [stroke] - 描边宽度，默认 1.6。
 */
function dfIcon(name, size, stroke) {
  const paths = DF_ICONS[name] || DF_ICONS.info
  const s = size || 16
  return h('svg', {
    width: s,
    height: s,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: stroke || 1.6,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
    focusable: 'false',
    style: { display: 'block', flex: 'none' },
  }, paths.map(function (d, i) { return h('path', { key: i, d: d }) }))
}
