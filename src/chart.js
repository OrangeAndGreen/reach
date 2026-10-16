// chart.js - one small SVG line chart, drawn with d3 scales: recessive grid,
// 2px lines, a crosshair with a tooltip on hover, direct labels at line ends.
// Colours come from CSS variables, so the chart follows the page theme.

const charts = new WeakMap();

/**
 * opts: {
 *   series: [{ name, color, points: [{x, y}], faint?: [{x, y}] }],
 *   x: { label, format, log? }, y: { label, format },
 *   onHover?: (x | null) => void, empty?: string, steps?: boolean
 * }
 */
export function lineChart(el, opts) {
  let state = charts.get(el);
  if (!state) {
    state = { opts };
    charts.set(el, state);
    new ResizeObserver(() => render(el, state.opts)).observe(el);
  }
  state.opts = opts;
  render(el, opts);
}

/** Bring one series forward and fade the rest; null clears it. */
export function focusSeries(el, name) {
  const svg = el.querySelector('svg');
  if (!svg) return;
  svg.classList.toggle('has-focus', name != null);
  for (const path of svg.querySelectorAll('.series')) path.classList.toggle('focused', path.dataset.name === name);
}

function render(el, opts) {
  el.innerHTML = '';
  const series = opts.series.filter((s) => s.points.some((p) => p.y != null));
  if (!series.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = opts.empty || 'Nothing to show yet.';
    el.append(empty);
    return;
  }
  const W = el.clientWidth || 400;
  const H = el.clientHeight || 260;
  // Past four lines the end labels would pile up, so the legend and tooltip carry the names.
  const labelled = series.length > 1 && series.length <= 4;
  const labelRoom = labelled ? 74 : 12;
  const m = { top: 10, right: labelRoom, bottom: 38, left: 56 };

  const all = series.flatMap((s) => s.points.filter((p) => p.y != null));
  const xs = all.map((p) => p.x);
  const xMin = opts.x.log ? Math.max(d3.min(xs), 1e-3) : 0;
  const x = (opts.x.log ? d3.scaleLog() : d3.scaleLinear())
    .domain([xMin, d3.max(xs)])
    .range([m.left, W - m.right]);
  const ys = all.map((p) => p.y).concat(series.flatMap((s) => (s.faint || []).filter((p) => p.y != null).map((p) => p.y)));
  const yLo = Math.min(0, d3.min(ys));
  const y = d3.scaleLinear().domain([yLo, d3.max(ys) || 1]).nice(5).range([H - m.bottom, m.top]);

  const svg = d3.select(el).append('svg').attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img')
    .attr('aria-label', `${opts.y.label} by ${opts.x.label}`);

  const yTicks = y.ticks(5);
  svg.append('g').selectAll('line').data(yTicks).join('line').attr('class', 'gridline')
    .attr('x1', m.left).attr('x2', W - m.right).attr('y1', (d) => y(d)).attr('y2', (d) => y(d));

  const xAxis = d3.axisBottom(x).ticks(opts.x.log ? 6 : Math.max(2, Math.floor((W - m.left - m.right) / 80)), opts.x.log ? '~s' : undefined)
    .tickFormat((d) => opts.x.format(d)).tickSizeOuter(0);
  if (opts.x.log) xAxis.tickValues(logTicks(x.domain()));
  svg.append('g').attr('class', 'axis').attr('transform', `translate(0,${H - m.bottom})`).call(xAxis);
  svg.append('g').attr('class', 'axis').attr('transform', `translate(${m.left},0)`)
    .call(d3.axisLeft(y).tickValues(yTicks).tickFormat((d) => opts.y.format(d)).tickSize(0).tickPadding(6))
    .call((g) => g.select('.domain').remove());
  svg.append('text').attr('class', 'axis-title').attr('x', (m.left + W - m.right) / 2).attr('y', H - 4)
    .attr('text-anchor', 'middle').text(opts.x.label);

  const line = (opts.steps ? d3.line().curve(d3.curveStepAfter) : d3.line())
    .defined((p) => p.y != null && (!opts.x.log || p.x > 0))
    .x((p) => x(p.x)).y((p) => y(p.y));

  for (const s of series) {
    if (s.faint) svg.append('path').attr('class', 'ring-series').attr('stroke', s.color).attr('d', line(s.faint));
    svg.append('path').attr('class', 'series').attr('stroke', s.color).attr('data-name', s.name).attr('d', line(s.points));
  }

  // Direct labels at each line's end, nudged apart so they never overlap.
  if (labelled) {
    const ends = series.map((s) => {
      const last = [...s.points].reverse().find((p) => p.y != null);
      return { s, x: x(last.x), y: y(last.y) };
    }).sort((a, b) => a.y - b.y);
    for (let k = 1; k < ends.length; k++) if (ends[k].y - ends[k - 1].y < 14) ends[k].y = ends[k - 1].y + 14;
    for (const e of ends) {
      svg.append('text').attr('class', 'direct-label').attr('x', e.x + 6).attr('y', e.y + 4).text(shortName(e.s.name));
    }
  }

  // Hover layer: crosshair, a dot per series, and a tooltip.
  const cross = svg.append('line').attr('class', 'crosshair').attr('y1', m.top).attr('y2', H - m.bottom).style('display', 'none');
  const dots = series.map((s) => svg.append('circle').attr('class', 'dot').attr('r', 4.5).attr('fill', s.color).style('display', 'none'));
  const tip = document.createElement('div');
  tip.className = 'tooltip';
  tip.hidden = true;
  el.append(tip);

  const hide = () => {
    cross.style('display', 'none');
    dots.forEach((d) => d.style('display', 'none'));
    tip.hidden = true;
    opts.onHover?.(null);
  };
  svg.append('rect').attr('x', m.left).attr('y', m.top).attr('width', W - m.left - m.right).attr('height', H - m.top - m.bottom)
    .attr('fill', 'transparent')
    .on('pointerleave', hide)
    .on('pointermove', (event) => {
      const [px] = d3.pointer(event);
      const xv = x.invert(px);
      cross.attr('x1', px).attr('x2', px).style('display', null);
      const rows = series.map((s, k) => {
        const p = nearest(s.points, xv);
        if (p && p.y != null) dots[k].attr('cx', x(p.x)).attr('cy', y(p.y)).style('display', null);
        else dots[k].style('display', 'none');
        return { s, p };
      }).filter((r) => r.p && r.p.y != null).sort((a, b) => b.p.y - a.p.y);
      tip.innerHTML = `<div class="t-head">${opts.x.format(xv, true)}</div>` + rows.map((r) =>
        `<div class="t-row"><i class="swatch" style="background:${r.s.color};width:10px;height:10px"></i><span>${escapeHtml(shortName(r.s.name))}</span><span>${opts.y.format(r.p.y, true)}</span></div>`).join('');
      tip.hidden = false;
      const left = px + 14 + tip.offsetWidth > W ? px - 14 - tip.offsetWidth : px + 14;
      tip.style.left = `${Math.max(0, left)}px`;
      tip.style.top = `${m.top}px`;
      opts.onHover?.(xv);
    });
}

function nearest(points, xv) {
  const i = d3.bisector((p) => p.x).center(points, xv);
  return points[i];
}

function logTicks([lo, hi]) {
  const out = [];
  for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) {
    for (const k of [1, 2, 5]) {
      const v = k * 10 ** e;
      if (v >= lo && v <= hi) out.push(v);
    }
  }
  return out;
}

const shortName = (name) => name.split(',')[0];

function escapeHtml(s) {
  return String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
}
