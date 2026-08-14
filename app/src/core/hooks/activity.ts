import { ActivityFeedResponseSchema } from '@paltalabs/shared'
import { useInfiniteQuery } from '@tanstack/react-query'
import { useCore } from '../context'

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
  })
}
