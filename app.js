import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { router } from "./src/routes.js";

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use("/collectionpay", router);

app.get("/", (_, res) => res.send("CollectionPay API Running"));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 SERVER ON : ${PORT}`));
