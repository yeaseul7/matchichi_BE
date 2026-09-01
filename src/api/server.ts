import "dotenv/config";
import {createApp} from "../app.js";
import {getPort} from "../config/env.js";

const port = getPort();

createApp().listen(port, "0.0.0.0", () => {
  console.log(`Cloud Run API server listening on port ${port}`);
});
