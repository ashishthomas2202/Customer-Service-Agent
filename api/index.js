// api/index.js
import app from "../app.js";
import serverless from "serverless-http";

export const config = { runtime: "nodejs20.x" };

const handler = serverless(app);

export default async function vercelHandler(req, res) {
  await app.ready();
  return handler(req, res);
}
