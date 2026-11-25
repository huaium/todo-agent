import { flushSync } from "react-dom";
import type { PlannerTask } from "../shared/planner.ts";

const rowSelector = ".task-row[data-task-id]";
const timing = { duration: 160, easing: "cubic-bezier(.2,.7,.3,1)" };
const animationId = "saved-task-row";

function visibleList() {
  return document.querySelector<HTMLElement>(".list-scroll:not([hidden])");
}

export function revealTaskResults() {
  const list = visibleList();
  if (
    !list?.clientHeight ||
    list.querySelector("[data-moving]") ||
    matchMedia("(prefers-reduced-motion: reduce)").matches
  )
    return;
  const bounds = list.getBoundingClientRect();
  const effects: Animation[] = [];
  for (const section of list.querySelectorAll(".task-section, .empty-list")) {
    const box = section.getBoundingClientRect();
    if (box.bottom <= bounds.top || box.top >= bounds.bottom) continue;
    effects.push(
      section.animate(
        [
          { opacity: 0.72, translate: "0 3px" },
          { opacity: 1, translate: "0 0" },
        ],
        { ...timing, id: "task-results" },
      ),
    );
  }
  return () => effects.forEach((effect) => effect.cancel());
}

export function cancelTaskRowAnimations() {
  for (const animation of document.getAnimations()) {
    if (animation.id === animationId) animation.cancel();
  }
}

function rowsIn(list: HTMLElement) {
  return Array.from(list.querySelectorAll<HTMLElement>(rowSelector));
}

function rowKey(row: HTMLElement) {
  return row.dataset.taskId + "/" + (row.dataset.parentRow ?? "");
}

// A section can disappear along with its last row. Its exit image belongs to the
// scroll container and must never become a second interactive or accessible task.
function fadeOut(
  list: HTMLElement,
  bounds: DOMRect,
  row: HTMLElement,
  box: DOMRect,
  done?: boolean,
) {
  const image = row.cloneNode(true) as HTMLElement;
  image.removeAttribute("data-task-id");
  image.removeAttribute("data-row-action");
  image.querySelectorAll("[id]").forEach((element) => element.removeAttribute("id"));
  image.inert = true;
  image.setAttribute("aria-hidden", "true");
  image.classList.add("task-row-exit");
  const checkbox = image.querySelector(".circle-check");
  const changed = checkbox && done !== undefined && done !== image.classList.contains("completed");
  if (changed) {
    image.classList.toggle("completed", done);
    checkbox.setAttribute("data-selected", String(done));
    checkbox
      .querySelector('[data-slot="checkbox-default-indicator--checkmark"]')
      ?.setAttribute("stroke-dashoffset", done ? "0" : "22");
  }
  Object.assign(image.style, {
    top: box.top - bounds.top + list.scrollTop + "px",
    left: box.left - bounds.left + list.scrollLeft + "px",
    width: box.width + "px",
    height: box.height + "px",
  });
  list.append(image);
  const fade = image.animate([{ opacity: 1 }, { opacity: 0 }], {
    id: animationId,
    duration: 120,
    delay: changed ? 75 : 0,
    easing: "ease-in",
    fill: "both",
  });
  fade.onfinish = fade.oncancel = () => image.remove();
}

export function publishTaskRows(tasks: PlannerTask[], publish: () => void) {
  const list = visibleList();
  if (!list || !list.clientHeight || list.querySelector("[data-moving]")) {
    publish();
    return;
  }
  const before = rowsIn(list);
  const control = document.activeElement;
  const focused =
    control?.closest<HTMLElement>(rowSelector) ??
    ((control === document.body || control?.closest('[role="alertdialog"]')) &&
      list.querySelector<HTMLElement>("[data-row-action]"));
  const motion = !matchMedia("(prefers-reduced-motion: reduce)").matches;
  const bounds = list.getBoundingClientRect();
  const visible = (box: DOMRect) =>
    box.height > 0 && box.bottom > bounds.top && box.top < bounds.bottom;
  const old = new Map(
    before.map((row) => [rowKey(row), { row, box: motion ? row.getBoundingClientRect() : null }]),
  );
  if (motion) cancelTaskRowAnimations();
  flushSync(publish);
  if (!list.isConnected || !list.clientHeight) return;
  const after = rowsIn(list);
  const next = new Map(after.map((row) => [rowKey(row), row]));
  if (focused && !focused.isConnected) {
    const index = before.indexOf(focused);
    const candidates = [focused, ...before.slice(index + 1), ...before.slice(0, index).reverse()];
    const neighbor = candidates.map((row) => next.get(rowKey(row))).find(Boolean);
    requestAnimationFrame(() => {
      if (!list.isConnected || document.activeElement !== document.body) return;
      const target =
        neighbor?.querySelector<HTMLElement>(".title-button, button:enabled") ??
        list.querySelector<HTMLElement>(".capture input") ??
        list.closest("main")?.querySelector<HTMLElement>("input.search");
      target?.focus({ preventScroll: true });
    });
  }
  if (!motion) return;
  const boxes = new Map(after.map((row) => [rowKey(row), row.getBoundingClientRect()]));
  const done = new Map(tasks.map((task) => [task.id, task.done]));
  for (const [key, { row, box }] of old) {
    const destination = boxes.get(key);
    if (box && visible(box) && (!destination || !visible(destination)))
      fadeOut(list, bounds, row, box, done.get(row.dataset.taskId!));
  }
  for (const row of after) {
    const box = boxes.get(rowKey(row))!;
    if (!visible(box)) continue;
    const previous = old.get(rowKey(row))?.box;
    const offset = previous ? previous.top - box.top : 4;
    if (previous && (!visible(previous) || Math.abs(offset) < 1)) continue;
    row.animate(
      [
        { translate: `0 ${offset}px`, opacity: previous ? 1 : 0 },
        { translate: "0 0", opacity: 1 },
      ],
      { ...timing, id: animationId },
    );
  }
}
