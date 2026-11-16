// Start center views at their operating region even when delivery history is unavailable.
const bounds = {
  all: [124.1, 32.95, 131.95, 38.8],
  osan: [126.08, 35.64, 129.43, 38.62],
  yeongnam: [127.48, 34.5, 129.75, 37.25],
  honam: [125.5, 34.1, 128.0, 36.23],
};

export function coverageCenterBounds(center) {
  return bounds[center] || bounds.all;
}
