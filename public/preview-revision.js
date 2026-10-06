export function shouldReloadPreview(nextRevision, renderedRevision, frameHasSource) {
  return !frameHasSource || nextRevision !== renderedRevision;
}
