const { v4: uuid } = require("uuid");
require("dotenv").config();

const initSubscribe = async (client) => {
  const response = await client.webhookSubscriptionsApi.listWebhookSubscriptions();
  const find = response.result.subscriptions?.find(
    (subscription) => subscription.name === "feelz-beverages-webhook"
  );
  if (find) {
    await client.webhookSubscriptionsApi.deleteWebhookSubscription(find.id);
  }
  client.webhookSubscriptionsApi
    .createWebhookSubscription({
      idempotencyKey: uuid(),
      subscription: {
        eventTypes: ["payment.updated", "payment.created", "order.updated", "order.fulfillment.updated"],
        notificationUrl: process.env.SERVER_URL + "/webhook",
        enabled: true,
        name: "feelz-beverages-webhook",
      },
    })
    .then((response) => {
      console.log('Webhook subscription created');
    })
    .catch((error) => {
      console.log(error);
    });
}

module.exports = initSubscribe
