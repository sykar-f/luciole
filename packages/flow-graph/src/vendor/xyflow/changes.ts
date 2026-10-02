// Adapted from xyflow, packages/react/src/utils/changes.ts and
// packages/system/src/utils/edges/general.ts (MIT, see LICENSE and README.md in this
// directory): typed without `any`, and without the resizer's attributes.
import type { Connection, Edge, EdgeChange, Node, NodeChange } from "../../types.ts";

type Change<T> =
  | { type: "add"; item: T; index?: number }
  | { type: "replace"; id: string; item: T }
  | { type: "remove"; id: string }
  | { type: "select"; id: string; selected: boolean }
  | { type: "position"; id: string; position?: Element["position"]; dragging?: boolean }
  | { type: "dimensions"; id: string };
type Element = { id: string; selected?: boolean; position?: unknown; dragging?: boolean };

/*
 * This function applies changes to nodes or edges that are triggered by the canvas.
 * When you drag a node for example, the canvas sends a position change update.
 * This function then applies the changes and returns the updated elements.
 */
function applyChanges<T extends Element>(
  changes: readonly Change<T>[],
  elements: readonly T[],
): T[] {
  const updatedElements: T[] = [];
  /*
   * By storing a map of changes for each element, we can a quick lookup as we
   * iterate over the elements array!
   */
  const changesMap = new Map<string, Change<T>[]>();
  const addItemChanges: { item: T; index?: number }[] = [];

  for (const change of changes) {
    if (change.type === "add") {
      addItemChanges.push(change);
      continue;
    } else if (change.type === "remove" || change.type === "replace") {
      /*
       * For a 'remove' change we can safely ignore any other changes queued for
       * the same element, it's going to be removed anyway!
       */
      changesMap.set(change.id, [change]);
    } else {
      const elementChanges = changesMap.get(change.id);

      if (elementChanges) {
        /*
         * If we have some changes queued already, we can do a mutable update of
         * that array and save ourselves some copying.
         */
        elementChanges.push(change);
      } else {
        changesMap.set(change.id, [change]);
      }
    }
  }

  for (const element of elements) {
    const queued = changesMap.get(element.id);

    /*
     * When there are no changes for an element we can just push it unmodified,
     * no need to copy it.
     */
    if (!queued) {
      updatedElements.push(element);
      continue;
    }

    const [first] = queued;
    // If we have a 'remove' change queued, it'll be the only change in the array
    if (first?.type === "remove") {
      continue;
    }

    if (first?.type === "replace") {
      updatedElements.push({ ...first.item });
      continue;
    }

    /**
     * For other types of changes, we want to start with a shallow copy of the
     * object so React knows this element has changed. Sequential changes will
     * each _mutate_ this object, so there's only ever one copy.
     */
    const updatedElement = { ...element };

    for (const change of queued) {
      applyChange(change, updatedElement);
    }

    updatedElements.push(updatedElement);
  }

  /*
   * we need to wait for all changes to be applied before adding new items
   * to be able to add them at the correct index
   */
  for (const change of addItemChanges) {
    if (change.index !== undefined) {
      updatedElements.splice(change.index, 0, { ...change.item });
    } else {
      updatedElements.push({ ...change.item });
    }
  }

  return updatedElements;
}

// A connection spread into an edge is one once it has an id: this narrows it to `E`.
function isElement<T>(item: unknown): item is T {
  return typeof item === "object" && item !== null && "id" in item;
}

// Applies a single change to an element. This is a *mutable* update.
function applyChange<T extends Element>(change: Change<T>, element: T): void {
  switch (change.type) {
    case "select": {
      element.selected = change.selected;
      break;
    }

    case "position": {
      if (typeof change.position !== "undefined") {
        element.position = change.position;
      }

      if (typeof change.dragging !== "undefined") {
        element.dragging = change.dragging;
      }

      break;
    }
  }
}

/** Applies what the canvas proposes (drag, selection, removal…) to the application's nodes. */
export function applyNodeChanges<N extends Node = Node>(
  changes: readonly NodeChange<N>[],
  nodes: readonly N[],
): N[] {
  return applyChanges(changes, nodes);
}

/** Applies what the canvas proposes to the application's edges. */
export function applyEdgeChanges<E extends Edge = Edge>(
  changes: readonly EdgeChange<E>[],
  edges: readonly E[],
): E[] {
  return applyChanges(changes, edges);
}

export const getEdgeId = ({ source, sourceHandle, target, targetHandle }: Connection | Edge) =>
  `xy-edge__${source}${sourceHandle || ""}-${target}${targetHandle || ""}`;

const connectionExists = (edge: Edge, edges: readonly Edge[]) =>
  edges.some(
    (el) =>
      el.source === edge.source &&
      el.target === edge.target &&
      (el.sourceHandle === edge.sourceHandle || (!el.sourceHandle && !edge.sourceHandle)) &&
      (el.targetHandle === edge.targetHandle || (!el.targetHandle && !edge.targetHandle)),
  );

/** `edges` with a new edge for `connection`, unless the same connection exists already. */
export function addEdge<E extends Edge = Edge>(
  connection: (Connection & Partial<Omit<E, keyof Connection>>) | E,
  edges: readonly E[],
  getId: (connection: Connection | Edge) => string = getEdgeId,
): E[] {
  if (!connection.source || !connection.target) return [...edges];
  const known = "id" in connection ? connection.id : undefined;
  const edge: Edge = { ...connection, id: typeof known === "string" ? known : getId(connection) };
  if (connectionExists(edge, edges)) return [...edges];
  if (edge.sourceHandle === null) delete edge.sourceHandle;
  if (edge.targetHandle === null) delete edge.targetHandle;
  return isElement<E>(edge) ? [...edges, edge] : [...edges];
}
