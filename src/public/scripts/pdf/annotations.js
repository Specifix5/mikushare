const SVG_NS = 'http://www.w3.org/2000/svg';
const MAX_MARKS = 500;
const MAX_POINTS = 2000;

export const pointOnPage = (event, bounds, width, height) => ({
  x: Math.max(
    0,
    Math.min(width, ((event.clientX - bounds.left) * width) / bounds.width),
  ),
  y: Math.max(
    0,
    Math.min(height, ((event.clientY - bounds.top) * height) / bounds.height),
  ),
});

export const pathData = (points) =>
  points
    .map(
      (point, index) =>
        `${index ? 'L' : 'M'}${point.x.toFixed(2)},${point.y.toFixed(2)}`,
    )
    .join(' ');

export const annotationElement = (mark) => {
  const element = document.createElementNS(
    SVG_NS,
    mark.tool === 'highlight' ? 'rect' : 'path',
  );
  if (mark.tool === 'highlight') {
    const [start, end] = [mark.points[0], mark.points.at(-1)];
    element.setAttribute('x', String(Math.min(start.x, end.x)));
    element.setAttribute('y', String(Math.min(start.y, end.y)));
    element.setAttribute('width', String(Math.abs(end.x - start.x)));
    element.setAttribute('height', String(Math.abs(end.y - start.y)));
    element.setAttribute('fill', mark.color);
    element.setAttribute('opacity', '0.25');
  } else {
    element.setAttribute('d', pathData(mark.points));
    element.setAttribute('fill', 'none');
    element.setAttribute('stroke', mark.color);
    element.setAttribute('stroke-width', String(mark.width));
    element.setAttribute('stroke-linecap', 'round');
    element.setAttribute('stroke-linejoin', 'round');
  }
  return element;
};

const segmentDistance = (point, start, end) => {
  const dx = end.x - start.x,
    dy = end.y - start.y;
  const amount = Math.max(
    0,
    Math.min(
      1,
      ((point.x - start.x) * dx + (point.y - start.y) * dy) /
        (dx * dx + dy * dy || 1),
    ),
  );
  return Math.hypot(
    point.x - start.x - amount * dx,
    point.y - start.y - amount * dy,
  );
};

export const hitsAnnotation = (mark, point, tolerance = 5) => {
  if (mark.tool === 'highlight') {
    const [a, b] = [mark.points[0], mark.points.at(-1)];
    return (
      point.x >= Math.min(a.x, b.x) &&
      point.x <= Math.max(a.x, b.x) &&
      point.y >= Math.min(a.y, b.y) &&
      point.y <= Math.max(a.y, b.y)
    );
  }
  return mark.points.some(
    (end, index) =>
      segmentDistance(point, mark.points[Math.max(0, index - 1)], end) <=
      Math.max(tolerance, mark.width),
  );
};

export const validateAnnotations = (input, pageCount) => {
  if (!Array.isArray(input)) return [];
  let points = 0;
  return input
    .slice(0, MAX_MARKS)
    .filter((mark) => {
      if (
        !mark ||
        !Number.isInteger(mark.page) ||
        mark.page < 1 ||
        mark.page > pageCount ||
        !['pen', 'highlight'].includes(mark.tool) ||
        !/^#[\da-f]{6}$/i.test(mark.color) ||
        !Number.isFinite(mark.width) ||
        mark.width < 1 ||
        mark.width > 12 ||
        !Array.isArray(mark.points) ||
        mark.points.length < 2 ||
        mark.points.length > MAX_POINTS
      )
        return false;
      points += mark.points.length;
      return (
        points <= 100000 &&
        mark.points.every(
          (point) =>
            Number.isFinite(point.x) &&
            Number.isFinite(point.y) &&
            point.x >= 0 &&
            point.y >= 0 &&
            point.x <= 20000 &&
            point.y <= 20000,
        )
      );
    })
    .map((mark) => ({
      page: mark.page,
      tool: mark.tool,
      color: mark.color,
      width: mark.width,
      points: mark.points.map(({ x, y }) => ({ x, y })),
    }));
};

export const annotationStore = (initial = []) => {
  let marks = [...initial];
  const undo = [],
    redo = [];
  const change = (next) => {
    undo.push(marks);
    if (undo.length > 100) undo.shift();
    redo.length = 0;
    marks = next;
  };
  return {
    get marks() {
      return marks;
    },
    get canUndo() {
      return !!undo.length;
    },
    get canRedo() {
      return !!redo.length;
    },
    add(mark) {
      if (marks.length >= MAX_MARKS)
        throw new Error(
          'Annotation limit reached. Save a copy before adding more.',
        );
      change([...marks, mark]);
    },
    erase(page, point, tolerance) {
      const index = marks.findLastIndex(
        (mark) => mark.page === page && hitsAnnotation(mark, point, tolerance),
      );
      if (index >= 0) change(marks.filter((_mark, i) => i !== index));
    },
    undo() {
      if (undo.length) {
        redo.push(marks);
        marks = undo.pop();
      }
    },
    redo() {
      if (redo.length) {
        undo.push(marks);
        marks = redo.pop();
      }
    },
  };
};

export const attachAnnotations = ({
  svg,
  page,
  viewport,
  tool,
  color,
  width,
  store,
  onChange,
}) => {
  let draft, pointer;
  const redraw = () => {
    svg.replaceChildren(
      ...store.marks
        .filter((mark) => mark.page === page())
        .map(annotationElement),
    );
    if (draft) svg.append(annotationElement(draft));
  };
  const coordinates = (event) =>
    pointOnPage(
      event,
      svg.getBoundingClientRect(),
      viewport().width,
      viewport().height,
    );
  const cancel = () => {
    draft = null;
    pointer = undefined;
    redraw();
  };
  svg.addEventListener('pointerdown', (event) => {
    if (tool.value === 'select' || event.button !== 0 || pointer !== undefined)
      return;
    event.preventDefault();
    if (tool.value === 'eraser') {
      store.erase(
        page(),
        coordinates(event),
        (8 * viewport().width) / svg.getBoundingClientRect().width,
      );
      redraw();
      onChange();
      return;
    }
    pointer = event.pointerId;
    svg.setPointerCapture(pointer);
    const point = coordinates(event);
    draft = {
      page: page(),
      tool: tool.value,
      color: color.value,
      width: Math.max(1, Math.min(12, Number(width.value) || 2)),
      points: [point, { ...point }],
    };
    redraw();
  });
  svg.addEventListener('pointermove', (event) => {
    if (!draft || event.pointerId !== pointer) return;
    const point = coordinates(event);
    if (draft.tool === 'highlight') draft.points[1] = point;
    else if (draft.points.length < MAX_POINTS) draft.points.push(point);
    redraw();
  });
  svg.addEventListener('pointerup', (event) => {
    if (!draft || event.pointerId !== pointer) return;
    const mark = draft;
    cancel();
    try {
      store.add(mark);
      onChange();
    } catch (error) {
      onChange(error.message);
    }
    redraw();
  });
  svg.addEventListener('pointercancel', cancel);
  return { redraw, cancel };
};
