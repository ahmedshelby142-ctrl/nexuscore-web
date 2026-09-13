import { useEffect, useState } from "react";

export function useMobileEntity<T>(reader: () => Promise<T | null>) {
  const [state, setState] = useState<{ data: T | null; loading: boolean; error: string | null }>({ data: null, loading: true, error: null });
  useEffect(() => {
    let active = true;
    setState({ data: null, loading: true, error: null });
    void reader().then((data) => { if (active) setState({ data, loading: false, error: null }); }).catch((error) => { if (active) setState({ data: null, loading: false, error: error instanceof Error ? error.message : String(error) }); });
    return () => { active = false; };
  }, [reader]);
  return state;
}