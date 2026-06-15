export const fetchJson = async <T>(url: string, options?: RequestInit) => {
  const res = await fetch(url, options);
  
  const contentType = res.headers.get("content-type") || "";
  const isJson = contentType.includes("application/json");

  if (!res.ok) {
    if (isJson) {
      const errorData = await res.json().catch(() => null);
      if (errorData?.error) {
        throw new Error(errorData.error);
      }
    }
    throw new Error(res.statusText);
  }

  if (!isJson) {
    const content = await res.text();
    throw new Error(`Did not receive json error:${content}`);
  }

  const data = (await res.json()) as T;
  return data;
};
