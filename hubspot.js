require('dotenv').config()

const hubspot = require('@hubspot/api-client')
const hubspotClient = new hubspot.Client({ accessToken: process.env.HUBSPOT_API_KEY })

module.exports = hubspotClient