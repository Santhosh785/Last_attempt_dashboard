require("dotenv").config();

async function getAccessToken() {
  const res = await fetch("https://accounts.zoho.in/oauth/v2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    }),
  });
  const data = await res.json();
  return data.access_token;
}

async function main() {
  const token = await getAccessToken();

  const res = await fetch(
    "https://www.zohoapis.in/bigin/v2/settings/fields?module=Contacts",
    {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
    }
  );

  const data = await res.json();
  const fields = data.fields || [];

  const customFields = fields.filter((f) => f.custom_field === true);

  console.log("Custom fields in Contacts module:\n");
  for (const f of customFields) {
    console.log(`Label: ${f.field_label}`);
    console.log(`API Name: ${f.api_name}`);
    console.log("---");
  }
}

main().catch(console.error);
