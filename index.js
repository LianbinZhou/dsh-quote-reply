/**
 * Host half of dsh-quote-reply.
 *
 * The feature is browser presentation only: selecting conversation text and
 * placing it into the composer draft touches no session event, no tool, and
 * no model request. This entry exists so the bundle patch can mount one
 * package row whose browser half (`./client`, declared under `dsh.client`)
 * carries the whole implementation.
 */
export function apply() {}
