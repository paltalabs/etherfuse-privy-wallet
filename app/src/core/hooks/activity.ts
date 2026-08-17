import { ActivityFeedResponseSchema, type ActivityFeedResponse } from '@paltalabs/shared'
import { useInfiniteQuery, type InfiniteData } from '@tanstack/react-query'
import { useCore } from '../context'

const POLL_MS = 5000

/**
 * `useActivity`'s `refetchInterval`: poll only while some already-loaded row
 * is still `pending` — the only state that changes without further user
 * action here (the worker's Horizon/ramp pollers confirm or fail it server
 * side, `docs/modules/api-indexer.md`). Lets a screen that lands on the feed
 * right after kicking something off (e.g. OnRamp's post-simulate redirect)
 * see the row settle without a manual refresh. Exported as a pure function so
 * the polling rule is unit-testable without fake timers.
 */
export function activityRefetchInterval(data: InfiniteData<ActivityFeedResponse> | undefined): number | false {
  const hasPending = data?.pages.some((page) => page.items.some((item) => item.status === 'pending')) ?? false
  return hasPending ? POLL_MS : false
}

/**
 * The merchant's activity feed, paginated backwards via the `before` cursor.
 * `nextBefore` is non-null only when more rows may exist (`docs/modules/api-history.md`) —
 * `getNextPageParam` returning that value verbatim means v5 treats a `null`
 * `nextBefore` as "no more pages" with no extra translation needed.
 */
export function useActivity() {
  const { client } = useCore()
  return useInfiniteQuery({
    queryKey: ['activity'],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      client.get(
        pageParam ? `/activity?before=${encodeURIComponent(pageParam)}` : '/activity',
        ActivityFeedResponseSchema,
      ),
    getNextPageParam: (lastPage) => lastPage.nextBefore,
    refetchInterval: (query) => activityRefetchInterval(query.state.data),
  })
}
