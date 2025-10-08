const namespace = Deno.env.get("NAMESPACE") || "default";
const labelSelector = Deno.env.get("LABEL_SELECTOR") || "app=my-app";
const port = parseInt(Deno.env.get("PORT") || "1993");
const cacheDurationMs = parseInt(Deno.env.get("CACHE_DURATION_MS") || "1_000"); // 1 second

const kubeApi = "https://kubernetes.default.svc";
const tokenPath = "/var/run/secrets/kubernetes.io/serviceaccount/token";
const token = Deno.env.get("TOKEN") || (await Deno.readTextFile(tokenPath));

let podCache: string[] = [];
let lastFetchTime = 0;

/**
 * Fetch pod IPs from the Kubernetes API.
 * Uses caching to minimize API calls.
 * @returns Array of pod IPs
 */
export async function fetchPods(): Promise<string[]> {
  const now = Date.now();
  if (now - lastFetchTime < cacheDurationMs && podCache.length > 0) {
    return podCache;
  }

  const res = await fetch(
    `${kubeApi}/api/v1/namespaces/${namespace}/pods?labelSelector=${labelSelector}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );

  if (!res.ok) {
    console.error("Failed to fetch pods:", await res.text());
    return [];
  }

  const data = await res.json();
  podCache = data.items.map((pod: any) => pod.status.podIP).filter(Boolean);
  lastFetchTime = now;
  return podCache;
}

/**
 * Broadcast a request to multiple pod IPs.
 * @param podIPs Array of pod IPs to broadcast the request to.
 * @param options Options for the request.
 */
export async function broadcastRequest(
  podIPs: string[],
  options: {
    pathname: string;
    method: string;
    port: number;
  },
) {
  for (const ip of podIPs) {
    try {
      const url = new URL(`http://${ip}`);
      url.port = options.port.toString();
      url.pathname = options.pathname;
      // Use the URL object to make the fetch call.
      const response = await fetch(url, {
        method: options.method,
      });

      console.log(`Sent to ${url.toString()}: ${response.status}`);
    } catch (err) {
      console.error(`Failed to send to ${ip}:`, err);
    }
  }
}

if (import.meta.main) {
  // Start the server.
  Deno.serve({ port }, async (req: Request): Promise<Response> => {
    const url: URL = new URL(req.url);

    console.log(`Received request: ${req.method} ${url.pathname}`);

    if (!url.pathname.startsWith("/broadcast")) {
      return new Response("Not Found", { status: 404 });
    }

    const pods = await fetchPods();

    console.log(`Broadcasting to pods: ${pods.join(", ")}`);

    await broadcastRequest(pods, {
      pathname: url.pathname.replace(/^\/broadcast/, ""),
      method: req.method,
      port: parseInt(url.searchParams.get("port") || "8080"),
    });
    return new Response("Broadcast complete", { status: 200 });
  });

  console.log(`Server running on port ${port}`);
}
