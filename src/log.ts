/** One JSON line to stdout per event. `pm2 logs slackbot` is the debugging interface. */
export function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));
}
