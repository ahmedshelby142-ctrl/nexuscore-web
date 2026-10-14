/** Saved human reference first. Historical IDs stay readable and searchable, never regenerated. */
export function posDocumentNumber(event: {id:string;refId?:string|null;payload?:unknown}): string {
 const p=event.payload && typeof event.payload==='object' ? event.payload as Record<string,unknown> : {};
 const number=p.documentNumber ?? p.sourceDocumentNumber ?? p.invoiceNumber ?? event.refId;
 return typeof number==='string' && number ? number : event.id;
}
