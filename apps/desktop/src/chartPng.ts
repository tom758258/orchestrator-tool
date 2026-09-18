const SVG_NS = 'http://www.w3.org/2000/svg'

function styledClone(source: SVGSVGElement): SVGSVGElement {
  const clone = source.cloneNode(true) as SVGSVGElement
  const originals = [source, ...source.querySelectorAll('*')]
  const copies = [clone, ...clone.querySelectorAll('*')]
  originals.forEach((element, index) => {
    const style = getComputedStyle(element)
    for (const property of ['fill', 'stroke', 'stroke-width', 'font-family', 'font-size', 'font-weight']) {
      copies[index].setAttribute(property, style.getPropertyValue(property))
    }
  })
  return clone
}

export async function chartPng(plot: HTMLDivElement | undefined): Promise<Uint8Array> {
  const source = plot?.querySelector<SVGSVGElement>('.recharts-wrapper > svg.recharts-surface')
  if (!source) throw new Error('No rendered chart is available to export.')
  const bounds = source.getBoundingClientRect()
  if (bounds.width <= 0 || bounds.height <= 0) throw new Error('Chart dimensions are unavailable.')
  const background = getComputedStyle(plot!).backgroundColor
  const chartBackground = background && background !== 'transparent' && background !== 'rgba(0, 0, 0, 0)'
    ? background : (document.documentElement.dataset.theme === 'dark' ? '#222326' : '#ffffff')
  const svg = styledClone(source)
  svg.setAttribute('width', String(bounds.width))
  svg.setAttribute('height', String(bounds.height))
  svg.setAttribute('viewBox', `0 0 ${bounds.width} ${bounds.height}`)

  // Recharts renders its legend outside the plot SVG. Include only its icons and labels.
  plot!.querySelectorAll('.recharts-legend-item').forEach(item => {
    const icon = item.querySelector<SVGSVGElement>('svg')
    if (icon) {
      const rect = icon.getBoundingClientRect()
      const copy = styledClone(icon)
      copy.setAttribute('x', String(rect.left - bounds.left))
      copy.setAttribute('y', String(rect.top - bounds.top))
      copy.setAttribute('width', String(rect.width))
      copy.setAttribute('height', String(rect.height))
      svg.append(copy)
    }
    const label = item.querySelector('.recharts-legend-item-text')
    if (label) {
      const rect = label.getBoundingClientRect()
      const style = getComputedStyle(label)
      const text = document.createElementNS(SVG_NS, 'text')
      text.textContent = label.textContent
      text.setAttribute('x', String(rect.left - bounds.left))
      text.setAttribute('y', String(rect.top - bounds.top + rect.height / 2))
      text.setAttribute('dominant-baseline', 'central')
      text.setAttribute('fill', style.color)
      text.setAttribute('font-family', style.fontFamily)
      text.setAttribute('font-size', style.fontSize)
      svg.append(text)
    }
  })

  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], {
    type: 'image/svg+xml;charset=utf-8',
  }))
  try {
    const image = new Image()
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('Could not render chart SVG.'))
      image.src = url
    })
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(bounds.width)
    canvas.height = Math.ceil(bounds.height)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas is unavailable.')
    context.fillStyle = chartBackground
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0, bounds.width, bounds.height)
    const png = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not encode PNG.')), 'image/png')
    })
    return new Uint8Array(await png.arrayBuffer())
  } finally {
    URL.revokeObjectURL(url)
  }
}
