export const validNotificationHour=hour=>Number.isInteger(hour)&&hour>=0&&hour<=23;

// Each subscribed recipient gets one digest per local calendar day, even if
// they change the delivery hour after receiving today's message.
export function isDigestDue(record,clock,hour){
  return record.enabled!==false&&validNotificationHour(hour)&&clock.hour===hour&&record.lastSent!==clock.date;
}
