const namespace = Deno.env.get("NAMESPACE") || "default";
const labelSelector = Deno.env.get("LABEL_SELECTOR") || "app=my-app";
const port = parseInt(Deno.env.get("PORT") || "1993");
const cacheDurationMs = parseInt(Deno.env.get("CACHE_DURATION_MS") || "1_000"); // 1 second

const debugTokens = new Set(["true", "1", "yes", "on"]);
const debugEnabled = (Deno.env.get("DEBUG") || "")
  .toLowerCase()
  .split(",")
  .map((token) => token.trim())
  .some((token) => debugTokens.has(token));

const kubeApi = "https://kubernetes.default.svc";
const tokenPath = "/var/run/secrets/kubernetes.io/serviceaccount/token";
const token = Deno.env.get("TOKEN") || (await Deno.readTextFile(tokenPath));

let podCache: string[] = [];
let lastFetchTime = 0;

function debugLog(...args: unknown[]) {
  if (!debugEnabled) {
    return;
  }
  console.debug("[debug]", ...args);
}

/**
 * Fetch pod IPs from the Kubernetes API.
 * Uses caching to minimize API calls.
 * @returns Array of pod IPs
 */
export async function fetchPods(): Promise<string[]> {
  const now = Date.now();
  if (now - lastFetchTime < cacheDurationMs && podCache.length > 0) {
    debugLog("Returning cached pod list", podCache);
    return podCache;
  }

  debugLog("Fetching pods from Kubernetes", { namespace, labelSelector });

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
  debugLog("Fetched pods", podCache);
  lastFetchTime = now;
  return podCache;
}

/**
 * Broadcast a request to multiple pod IPs.
 * @param podIPs Array of pod IPs to broadcast the request to.
 * @param options Options for the request.
 */
export async function broadcastRequest(
  podIPsPromise: string[] | Promise<string[]>,
  options: {
    pathname: string;
    method: string;
    port: number;
    search?: string;
  },
): Promise<{ ip: string; status: number | null; error?: string }[]> {
  const podIPs = await podIPsPromise;

  debugLog("Starting broadcast request", { podIPs, options });

  return Promise.all(
    podIPs.map(async (ip) => {
      try {
        const url = new URL(`http://${ip}`);
        url.port = options.port.toString();
        url.pathname = options.pathname;
        if (options.search) {
          url.search = options.search;
        }

        debugLog("Broadcasting to IP", { ip, url: url.toString(), method: options.method });

        const response = await fetch(url, {
          method: options.method,
        });

        console.log(`Broadcast to ${url.toString()}: ${response.status}`);

        debugLog("Response headers", Object.fromEntries(response.headers.entries()));

        return { ip, status: response.status };
      } catch (err) {
        console.error(`Failed to send to ${ip}:`, err);

        debugLog("Broadcast failure details", {
          ip,
          port: options.port,
          pathname: options.pathname,
          method: options.method,
          error: err instanceof Error ? err.message : String(err),
        });

        return { ip, status: null, error: String(err) };
      }
    }),
  );
}

/**
 * Handle incoming requests.
 * @param req Incoming request
 * @returns Response
 */
export const serverHandler = async (req: Request): Promise<Response> => {
  const url: URL = new URL(req.url);

  debugLog("Full request details", {
    method: req.method,
    url: url.toString(),
    headers: Object.fromEntries(req.headers.entries()),
  });

  if (!url.pathname.startsWith("/broadcast")) {
    console.log(`No match for ${url.pathname}`);
    return new Response("Not Found", { status: 404 });
  }

  const {
    _port,
    _wait,
    ...searchObject
  } = Object.fromEntries(url.searchParams);

  const podsPromise = fetchPods();

  const broadcastPromise = broadcastRequest(podsPromise, {
    port: parseInt(_port) || 8080,
    method: req.method,
    search: new URLSearchParams(searchObject).toString(),
    pathname: url.pathname.replace(/^\/broadcast/, ""),
  });

  if (_wait === "true") {
    await broadcastPromise;
    return new Response("Broadcast complete", { status: 200 });
  }

  broadcastPromise.catch((err) =>
    console.error("Broadcast error (async):", err),
  );
  return new Response("Broadcast started", { status: 202 });
};

if (import.meta.main) {
  // Start the server.
  Deno.serve({ port }, serverHandler);
  console.log(`Server running on port ${port}`);
}
