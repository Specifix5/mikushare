import { PDFDocument, rgb } from 'pdf-lib';
import { downloadBlob } from './download.js';

export const exportPDF = async (source, renderer, marks, filename) => {
  // Load the original bytes and append vector drawing operators. No page screenshots.
  const document = await PDFDocument.load(await source(), {
    updateMetadata: false,
  });
  for (const number of new Set(marks.map((mark) => mark.page))) {
    const page = document.getPage(number - 1);
    const viewport = (await renderer.getPage(number)).getViewport({ scale: 1 });
    for (const mark of marks.filter((mark) => mark.page === number)) {
      const color = rgb(
        ...[1, 3, 5].map(
          (offset) => parseInt(mark.color.slice(offset, offset + 2), 16) / 255,
        ),
      );
      const points = mark.points.map((point) =>
        viewport.convertToPdfPoint(point.x, point.y),
      );
      if (mark.tool === 'highlight') {
        const [a, b] = [mark.points[0], mark.points.at(-1)];
        const corners = [
          [a.x, a.y],
          [b.x, a.y],
          [b.x, b.y],
          [a.x, b.y],
        ].map(([x, y]) => viewport.convertToPdfPoint(x, y));
        const path =
          corners
            .map(([x, y], index) => `${index ? 'L' : 'M'}${x},${-y}`)
            .join(' ') + ' Z';
        page.drawSvgPath(path, { color, opacity: 0.25 });
      } else {
        for (let index = 1; index < points.length; index++) {
          const [x, y] = points[index - 1],
            [endX, endY] = points[index];
          page.drawLine({
            start: { x, y },
            end: { x: endX, y: endY },
            thickness: (() => {
              const a = viewport.convertToPdfPoint(0, 0);
              const b = viewport.convertToPdfPoint(mark.width, 0);
              return Math.hypot(b[0] - a[0], b[1] - a[1]);
            })(),
            color,
          });
        }
      }
    }
  }
  const bytes = await document.save();
  downloadBlob(
    new Blob([bytes], { type: 'application/pdf' }),
    filename.replace(/\.pdf$/i, '') + '-annotated.pdf',
  );
};
