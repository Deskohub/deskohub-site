const prefix = "workspace-open-space-move:";

export const formatOpenSpaceMoveMarker = (generation: string) =>
  `${prefix}${generation}`;

const isOpenSpaceMoveMarker = (line: string) => line.startsWith(prefix);

export const hasOpenSpaceMoveMarker = (note: string | null | undefined) =>
  note?.split("\n").some(isOpenSpaceMoveMarker) ?? false;

export const withoutOpenSpaceMoveMarkers = (note: string | null | undefined) =>
  (note ?? "").split("\n").filter((line) => !isOpenSpaceMoveMarker(line));
