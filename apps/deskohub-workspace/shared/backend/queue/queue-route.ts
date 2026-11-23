import { env } from "@/env";
import { defineCloudTasksQueueRoute } from "./cloud-tasks-queue-consumer";
import type { QueueConsumer } from "./queue-consumer";
import { defineVercelQueueRoute } from "./vercel-queue-consumer";

/**
 * A queue handler route for whichever transport delivers on this host: Vercel
 * Queues on Vercel, the default, and Cloud Tasks on a container host. Both
 * run the same `consume` for `topic`.
 */
export const defineQueueRoute = (
  operation: string,
  topic: string,
  consume: QueueConsumer<never>
) => {
  const vercel = defineVercelQueueRoute(operation, consume);
  const cloudTasks = defineCloudTasksQueueRoute(operation, topic, consume);
  return (request: Request): Promise<Response> =>
    env.WORKSPACE_RUNTIME_HOST === "container"
      ? cloudTasks(request)
      : vercel(request);
};
