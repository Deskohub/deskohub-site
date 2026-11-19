import { createRoot } from "react-dom/client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "./dialog";

const root = document.getElementById("root");
if (!root) throw new Error("The dialog browser harness root is missing.");

createRoot(root).render(
  <Dialog>
    <DialogTrigger>Open dialog</DialogTrigger>
    <DialogContent locale="en-US">
      <DialogTitle>Reservation dialog</DialogTitle>
      <DialogDescription>Choose a reservation option.</DialogDescription>
    </DialogContent>
  </Dialog>
);
