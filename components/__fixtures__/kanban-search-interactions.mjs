// Board interaction tests inspect the existing drag hook contracts without DOM hit-testing.
export const dragOptions = { card: null, lane: null };
export const laneBegins = [];
export let mobile = false;
export function setMobile(value) { mobile = value; }
export function useIsMobile() { return mobile; }
export function useKanbanCardDrag(options) {
  dragOptions.card = options;
  return { view: null, handlers: { onPointerDown() {}, onTouchMove() {} }, onClickCapture() {}, onPointerDownCapture() {} };
}
export function useKanbanLaneDrag(options) {
  dragOptions.lane = options;
  return { view: { draggingLaneId: null, dropIndex: null, ghostRef: { current: null } }, beginDrag(_event, laneId) { laneBegins.push(laneId); } };
}
export function placeSidebarMenu() { return { left: 0, top: 0 }; }
