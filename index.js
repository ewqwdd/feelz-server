const express = require("express");
const cors = require("cors");
const { Client, Environment, ApiError } = require("square");
require("dotenv").config();
const initSubscribe = require("./subscription");
const memberstackAdmin = require("@memberstack/admin");
const { v4: uuid } = require("uuid");
const lookup = require("country-code-lookup");
const { google } = require("googleapis");
const hubspotClient = require("./hubspot");
const cron = require('node-cron');

const getPromos = async () => {
  const auth = await google.auth.getClient({
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: "promos!A:D",
  });
  const values = response.data.values.slice(1);
  return values;
};

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

cron.schedule('0 0 * * *', () => {
  initSubscribe(client);
});

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
        const all = await memberstack.members.list({ limit: 99999 });
        const found = all.data.find((m) => m.customFields?.square_id === customerId);

        // Update member data with order details
        if (found) {
          const { data: member } = await memberstack.members.retrieve({ id: found.id });
          console.log("Member found", member);
          const json = member?.json || { orders: {} };
          if (!Object.keys(json.orders).includes(order_id)) {
            json.orders[order_id] = {
              items: order.lineItems.map((item) => ({
                name: item.name,
                quantity: item.quantity,
                amount: item.totalMoney.amount.toString(),
              })),
              date: new Date().toISOString(),
            };
            await memberstack.members.update({ id: member.id, data: { json } });
            console.log("Member updated");
          }
        }
      }
    }
  }
});

app.post("/checkout", async (req, res) => {
  const { products, id, promo } = req.body;

  let customerId;
  let email;
  let customFields;
  let iso;
  let discounts = [];
  let applied_discounts;

  try {
    // Check if promo code is valid
    if (promo) {
      const values = await getPromos();
      const current = values.find((v) => v[0] === promo);
      if (current) {
        discounts.push({
          percentage: current[1].replace("%", ""),
          uid: "1",
          name: "Promocode",
          type: "FIXED_PERCENTAGE",
          scope: "ORDER",
        });
        applied_discounts = [
          {
            discount_uid: "1",
            uid: "d1",
          },
        ];
      }
    }
    console.log(discounts);
    console.log(applied_discounts);

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
            await memberstack.members.update({
              id,
              data: { customFields: { square_id: result.customer.id } },
            });
          }
        }
      }
    }

    const summary = products.map(({ name, quantity, basePriceMoney }) => ({
      name,
      quantity,
      amount: basePriceMoney?.amount * Number(quantity),
      applied_discounts,
    }));

    if (customFields?.country) {
      iso = lookup.byCountry(customFields.country)?.iso2;
    }
    // Create checkout
    const response = await client.checkoutApi.createCheckout(LOCATION_ID, {
      idempotencyKey: uuid(),
      order: {
        order: {
          discounts,
          customerId: customerId,
          locationId: LOCATION_ID,
          lineItems: products,
        },
        idempotencyKey: uuid(),
      },
      askForShippingAddress: true,
      redirectUrl: process.env.WEBFLOW_URL + "/thanks?products=" + encodeURI(JSON.stringify(summary)),
      prePopulateBuyerEmail: email,
      prePopulateShippingAddress: {
        firstName: customFields?.["first-name"],
        lastName: customFields?.["last-name"],
        country: iso,
        addressLine1: customFields?.address,
        addressLine2: customFields?.["apartment-suite-etc"],
        addressLine3: customFields?.city,
        postalCode: customFields?.["postal-code"],
        administrativeDistrictLevel1: customFields?.state,
      },
    });

    res.json({ url: response.result.checkout.checkoutPageUrl });
    return;
  } catch (error) {
    res.status(500).json({ error: error.message });
    console.log(error);
  }
});

app.post("/promo", async (req, res) => {
  const code = req.body.code;
  try {
    const values = await getPromos();
    const current = values.find((promo) => promo[0] === code);
    if (current) {
      return res.json({ valid: true, discount: current[1] });
    } else {
      return res.json({ valid: false });
    }
  } catch (error) {
    console.log(error);
    return res.status(500).json({ error: error.message });
  }
});

app.post("/memberstack-webhook", async (req, res) => {
  const { event, payload } = req.body;

  const id = payload?.id ?? payload.member?.id;
  const member = await memberstack.members.retrieve({ id });
  console.log(member);
  if (member && member.data.planConnections.find((p) => p.planId === "pln_wholesale-win3042x")) {
    const email = member.data.auth.email;
    const hubspotUser = await hubspotClient.crm.companies.searchApi.doSearch({
      filterGroups: [
        {
          filters: [
            {
              value: id,
              propertyName: "memberstack_id",
              operator: "EQ",
            },
          ],
        },
      ],
      properties: ["owneremail", "name", "memberstack_id"],
    });
    console.log(hubspotUser);

    const user = hubspotUser.results?.[0];
    if (user) {
      // await hubspotClient.crm.companies.basicApi.update(user.id, {
      //   properties: {
      //     memberstack_id: id
      //   }
      // })
      return res.status(200).json({ message: "Memberstack ID added to Hubspot" });
    }

    await hubspotClient.crm.companies.basicApi.create({
      properties: {
        owneremail: email,
        memberstack_id: id,
        name: member.data.customFields?.["company-name"] || email,
        phone: member.data.customFields?.['phone-number'],
        primary_phone: member.data.customFields?.['phone-number'],
        city: member.data.customFields?.city,
      },
    });
    return res.status(200).json({ message: "Memberstack ID added to Hubspot" });
  }
});

app.listen(process.env.PORT, () => {
  console.log("Server is running");
});
