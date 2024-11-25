const express = require("express");
const cors = require("cors");
const { Client, Environment, ApiError } = require("square");
require("dotenv").config();
const initSubscribe = require("./subscription");
const memberstackAdmin = require("@memberstack/admin");
const { v4: uuid } = require("uuid");


const app = express();

app.use(cors());

app.use(express.json());

const memberstack = memberstackAdmin.init(process.env.MEMBERSTACK_SECRET);

const client = new Client({
  bearerAuthCredentials: {
    accessToken: process.env.SQUARE_ACCESS_TOKEN,
  },
  environment: Environment.Sandbox,
});

const LOCATION_ID = "L3PDBG0452N3H";
initSubscribe(client);

app.post("/webhook", async (req, res) => {
  if (req.body.type === "payment.updated") {
    const { payment } = req.body.data.object;

    // Process completed payments
    if (payment.status === "COMPLETED") {
      console.log("Payment completed");
      const { order_id } = payment;

      // Getting order details

      const response = await client.ordersApi.retrieveOrder(order_id);
      const order = response.result.order;

      if (order.state === "COMPLETED") {
        const { customerId } = order;
        console.log("Order completed", customerId);

        // find member in memberstack
        const all = await memberstack.members.list({limit: 99999})
        const found = all.data.find(m => m.customFields?.square_id === customerId);

        // Update member data with order details
        if (found) {
          const {data: member} = await memberstack.members.retrieve({ id: found.id });
          console.log("Member found", member);
          const json = member?.json ?? { products: [], orders: [] };
          if (!json.orders.includes(order_id)) {
            json.products.push(...order.lineItems.map((item) => ({ name: item.name, quantity: item.quantity, amount: item.totalMoney.amount.toString() })));
            json.orders.push(order_id);
            await memberstack.members.update({ id: member.id, data: { json } });
            console.log("Member updated");
          }
        }
      }
    }
  }
});

app.post("/checkout", async (req, res) => {
  const { products, id } = req.body;

  let customerId;
  let email;
  let customFields;

  try {
    // Check if member exists in memberstack and create customer in square
    if (id) {
      const member = await memberstack.members.retrieve({ id });
      if (member) {
        const { auth } = member.data;
        customFields = member.data.customFields;
        email = auth.email;
        if (customFields.square_id) {
          customerId = customFields.square_id;
        } else {

          const { result } = await client.customersApi.createCustomer({
            emailAddress: auth.email,
          });
          if (result) {
            customerId = result.customer.id;
            await memberstack.members.update({ id, data: { customFields: { square_id: result.customer.id } } })
          }
        }
      }
    }
    console.log('customFields', customFields)

    // Create checkout
    const response = await client.checkoutApi.createCheckout(LOCATION_ID, {
      idempotencyKey: uuid(),
      order: {
        order: {
          customerId: customerId,
          locationId: LOCATION_ID,
          lineItems: products,
        },
        idempotencyKey: uuid(),
      },
      askForShippingAddress: true,
      redirectUrl: process.env.WEBFLOW_URL + "/thanks",
      prePopulateBuyerEmail: email,
      prePopulateShippingAddress: {
        firstName: customFields?.["first-name"],
        lastName: customFields?.["last-name"],
      }
    });

    console.log(response.result.checkout)

    res.json({ url: response.result.checkout.checkoutPageUrl });
    return;
  } catch (error) {
    res.status(500).json({ error: error.message });
    console.log(error);
  }
});

app.listen(process.env.PORT, () => {
  console.log("Server is running");
});
