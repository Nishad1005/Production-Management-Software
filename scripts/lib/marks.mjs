/**
 * Numbered markers drawn into a page before it is photographed.
 *
 * Shared by the walkthrough (KRAM/09) and the click guide (KRAM/11). Drawn into
 * the DOM rather than composited onto the PNG afterwards: a badge is positioned
 * from the element's own box, so when a panel moves the number moves with it
 * and nothing has to be re-measured by hand. `ring` draws a frame round the
 * element as well, for targets too small to find by a number beside them.
 *
 * Highlighter yellow on ink, because every colour the application itself uses
 * means something — red is a breach, green is clear, amber is a warning — and
 * an annotation must not be mistaken for a reading.
 */

/** A locator's box in document coordinates, so a clip can be taken full-page. */
export async function box(page, locator) {
  const target = locator.first()
  await target.waitFor({ state: 'visible', timeout: 30_000 })
  const b = await target.boundingBox()
  if (!b) throw new Error('no bounding box')
  const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }))
  return { x: b.x + scroll.x, y: b.y + scroll.y, width: b.width, height: b.height }
}

/**
 * Places the markers. Each target is `{ n, at, where, ring, dx, dy }` where
 * `at` is a locator and `where` is one of left (default), right, above, below,
 * top-left, inside, inside-right.
 */
export async function mark(page, targets) {
  const placed = []
  for (const t of targets) {
    const b = await box(page, t.at)
    placed.push({
      n: t.n,
      ring: !!t.ring,
      where: t.where ?? 'left',
      dx: t.dx ?? 0,
      dy: t.dy ?? 0,
      ...b,
    })
  }
  await page.evaluate((items) => {
    document.getElementById('__marks')?.remove()
    const layer = document.createElement('div')
    layer.id = '__marks'
    layer.style.cssText =
      'position:absolute;left:0;top:0;width:0;height:0;z-index:2147483000;pointer-events:none;'
    for (const m of items) {
      if (m.ring) {
        const r = document.createElement('div')
        r.style.cssText =
          `position:absolute;left:${m.x - 5}px;top:${m.y - 5}px;width:${m.width + 10}px;` +
          `height:${m.height + 10}px;border-radius:5px;` +
          'box-shadow:0 0 0 2px #16202e,0 0 0 5px #ffd60a;'
        layer.appendChild(r)
      }
      const size = 26
      let x = m.x - size - 8
      let y = m.y + m.height / 2 - size / 2
      if (m.where === 'top-left') { x = m.x - size / 2; y = m.y - size / 2 }
      if (m.where === 'right') { x = m.x + m.width + 8 }
      if (m.where === 'inside') { x = m.x + 8; y = m.y + 8 }
      if (m.where === 'inside-right') { x = m.x + m.width - size - 8 }
      if (m.where === 'above') { x = m.x + m.width / 2 - size / 2; y = m.y - size - 6 }
      if (m.where === 'below') { x = m.x + m.width / 2 - size / 2; y = m.y + m.height + 6 }
      x = Math.max(4, x + m.dx)
      y = Math.max(4, y + m.dy)
      const b = document.createElement('div')
      b.textContent = String(m.n)
      b.style.cssText =
        `position:absolute;left:${x}px;top:${y}px;width:${size}px;height:${size}px;` +
        'border-radius:50%;background:#ffd60a;color:#16202e;border:2px solid #16202e;' +
        "font:700 14px/22px 'Archivo Variable','Archivo',system-ui,sans-serif;text-align:center;" +
        'box-shadow:0 1px 4px rgba(22,32,46,.45);box-sizing:border-box;'
      layer.appendChild(b)
    }
    document.body.appendChild(layer)
  }, placed)
}

/** Takes the markers off again, so the next picture starts clean. */
export async function unmark(page) {
  await page.evaluate(() => document.getElementById('__marks')?.remove())
}
