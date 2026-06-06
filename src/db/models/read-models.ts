import mongoose from "mongoose";

const looseSchema = new mongoose.Schema({}, { strict: false });

export const OfficeModel =
  mongoose.models.Office ||
  mongoose.model("Office", looseSchema, "offices");

export const CategoryModel =
  mongoose.models.Category ||
  mongoose.model("Category", looseSchema, "categories");

export const AddOnModel =
  mongoose.models.AddOn ||
  mongoose.model("AddOn", looseSchema, "addons");

export const VehicleModel =
  mongoose.models.Vehicle ||
  mongoose.model("Vehicle", looseSchema, "vehicles");

export const ReservationModel =
  mongoose.models.Reservation ||
  mongoose.model("Reservation", looseSchema, "reservations");