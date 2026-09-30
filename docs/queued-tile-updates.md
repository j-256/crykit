# Queued tile updates

Use [useQueuedTileUpdates](../src/ui/useQueuedTileUpdates.ts) for tiles that save each click immediately and allow repeated clicks while earlier saves finish. Class seals, Travel & unlocks, and Quintar breeding share this pattern. Forms with an explicit submit action keep their own draft and submit behavior.

## Display the latest requested state

Each tile key has a pending operation count and a requested state. Enqueueing a click applies a pure transition to the previous requested state, or to the supplied base state if that tile has no pending operations. A synchronous ref lets clicks in the same React batch build on one another. The render snapshot supplies the displayed state.

Keep that requested state visible until every operation for the key settles. An intermediate save acknowledgment only decrements its count. It must not replace the requested state with an older persisted state. After the final operation settles, remove the overlay and display the application's state again. Different tile keys drain independently.

Read the same displayed state for the tile's artwork, labels, accessible state, counters, next-step selection, and prerequisite messages. Mixing queued and persisted values produces contradictory states while saves finish.

```tsx
const { queuedUpdates, enqueue } = useQueuedTileUpdates<StepId, boolean>()
const isComplete = (id: StepId) => queuedUpdates.get(id)?.state ?? savedCompletion(id)
const toggle = useCallback((id: StepId, complete: boolean) => {
  setError(undefined)
  enqueue(id, complete, state => !state, () => onToggle(id), reason => {
    setError(current => current ?? formatError(reason))
  })
}, [enqueue, onToggle])
```

The base state passed by a tile can be its displayed state: an existing queue entry takes precedence. Keep transitions pure, since they describe the requested display state. Persist domain commands against the latest application revision through the application save layer.

## Keep persistence in the application queue

The hook calls each commit callback immediately, in click order. It tracks the display overlay; it does not serialize writes. Submit every operation to `commitLocalData`, which serializes transactions, updates the canonical application state, and registers pending work for the tab-close guard before asynchronous work begins. Do not add a second deferred queue in the page or hook: unregistered intentions could otherwise be lost on tab close.

Use `{ showSavingState: false }` for these immediate tile transactions. The application still records pending work and reports errors. The shared context bar should not cycle through saving labels or disable its controls for every click. Set `aria-busy` on the affected tile while its key is pending, keep the tile button enabled, and keep its action and status labels tied to the requested state. A transient spinner or "Saving..." label would reintroduce visible flashes.

Choose failure behavior in the save layer. Quintar breeding uses `rollbackOnFailure: true` and reveals the saved state after the tile's queue drains. Class seals retains a failed draft for the application's recovery workflow. The hook reports rejections, including synchronous callback failures, and drains their counts without silently retrying. A visible error is required; queued optimism does not prove that a write succeeded. Disable a separate retry action until the failed tile's remaining operations settle, then retry against the revealed state.

Mount the board with a key for its owning Playthrough so its display overlay cannot carry into another Playthrough. Keep context changes ordered with saves, and capture explicit record or Playthrough targets before deferring operations that could otherwise resolve against a different context.

## Keep unrelated tiles stable

Memoize tile components and keep their action callbacks stable with `useCallback`. Pass primitive derived values or stable objects. When deriving a list for each tile, pass a stable representation or compare its contents: a newly allocated array on every application save defeats shallow memoization. Preserve tile keys and avoid rebuilding unchanged DOM. Dependent prerequisite text and next-step markers should update when their meaning changes.

Use `pendingCount` to guard conflicting bulk actions. Do not disable ordinary tile clicks while their own or another tile's save is pending.

## Verify the behavior

The [hook tests](../src/ui/useQueuedTileUpdates.test.tsx) hold save promises open and acknowledge them individually. They check batched clicks, immediate registration, intermediate acknowledgments, independent keys, and failed operations. The [Class seals](../e2e/progress-board.spec.ts), [Travel & unlocks](../e2e/travel-unlocks.spec.ts), and [Quintar breeding](../e2e/quintar-breeding.spec.ts) browser tests verify repeated clicks, persisted results, the tab-close guard, and unchanged unrelated tiles and context controls. Quintar tests also observe completion attributes and rendered frames while the queue drains.

For a new board, verify an odd and even toggle sequence or a full state cycle, keep its button interactive, and confirm the final requested state stays visible through intermediate saves. Exercise save failure and recovery, reload persistence, and Playthrough switching. Check desktop and narrow layouts in the running app. Static source checks cannot establish that intermediate states never reach the screen; controlled save tests and browser observations cover that behavior.
