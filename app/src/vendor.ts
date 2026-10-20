/* The vendor loader: an optional library, fetched on first use.
 *
 * A vendor file is fetched the first time something asks for it, and never
 * before. That is not a micro-optimisation — it is the difference between a
 * boot that costs 245 KB and one that costs nothing, and SheetJS is 245 KB
 * that a CSV import must never wait on and a boot must never pay for.
 *
 * The rule every integration follows: a vendor file that fails to load leaves
 * the app in its native behaviour rather than breaking the screen that asked
 * for it. So `loadVendor` rejects, and the caller decides what "without it"
 * means — for the workbook importer, that is a sentence saying the file could
 * not be read and suggesting CSV.
 *
 * Class-only and attribute-only: the script element is created in JavaScript,
 * never written into the document as markup, so the strict
 * `script-src 'self'` policy is satisfied by the same file the app already
 * loads.
 */

const cache = new Map<string, Promise<void>>();

/** Load a vendor file once, and remember that it is on its way. */
export function loadVendor(name: string, { js, css }: { js?: string; css?: string } = {}): Promise<void> {
  const hit = cache.get(name);
  if (hit) return hit;
  const promise = new Promise<void>((resolve, reject) => {
    // Wait for EVERY requested asset (a library's JS plus its optional CSS)
    // before resolving — settling on whichever loads first could resolve while
    // the JS global is still undefined, and the caller's one-shot `.then` would
    // then never wire the widget.
    let pending = 0;
    const done = (): void => { pending -= 1; if (pending <= 0) resolve(); };
    const fail = (asset: string) => reject(new Error(`vendor asset failed: ${asset}`));
    if (css) {
      pending += 1;
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = css;
      link.onload = done;
      link.onerror = () => fail(css);
      document.head.appendChild(link);
    }
    if (js) {
      pending += 1;
      const script = document.createElement('script');
      script.src = js;
      script.async = true;
      script.onload = done;
      script.onerror = () => fail(js);
      document.head.appendChild(script);
    }
    if (!pending) resolve();
  });
  cache.set(name, promise);
  return promise;
}

/** Whether a vendor file has already been asked for. The boot budget guard
 *  reads this to tell "not yet needed" from "needed and on its way". */
export function vendorRequested(name: string): boolean {
  return cache.has(name);
}
