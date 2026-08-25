function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function coordinate(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

export function renderSparkline(
  series: readonly (number | undefined)[],
  options: { readonly width?: number; readonly height?: number; readonly label?: string } = {},
): string {
  const width = options.width ?? 240;
  const height = options.height ?? 64;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    throw new Error("sparkline dimensions are invalid");
  }
  const defined = series.filter((value): value is number => value !== undefined && Number.isFinite(value));
  const minimum = defined.length ? Math.min(...defined) : 0;
  const maximum = defined.length ? Math.max(...defined) : 0;
  const span = maximum === minimum ? 1 : maximum - minimum;
  const x = (index: number): number => series.length <= 1 ? width / 2 : index * width / (series.length - 1);
  const y = (value: number): number => height - ((value - minimum) / span) * height;
  const paths: string[] = [];
  let segment: string[] = [];
  const finish = (): void => {
    if (segment.length > 0) paths.push(`<path d="${segment.join(" ")}"/>`);
    segment = [];
  };
  for (const [index, value] of series.entries()) {
    if (value === undefined || !Number.isFinite(value)) {
      finish();
      continue;
    }
    segment.push(`${segment.length === 0 ? "M" : "L"}${coordinate(x(index))},${coordinate(y(value))}`);
  }
  finish();
  const label = escapeAttribute(options.label ?? "Metric trend");
  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${label}" viewBox="0 0 ${coordinate(width)} ${coordinate(height)}" preserveAspectRatio="none">${paths.join("")}</svg>`;
}
