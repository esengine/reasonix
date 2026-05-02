/** Seed retail tasks — DB-end-state predicates avoid LLM-judge flakiness in the reproducibility report. */

import { getRow, setField } from "./db.js";
import type { TaskDefinition, ToolFactory, WorldState } from "./types.js";

const RETAIL_SYSTEM = `You are a retail support agent. Use the tools to help the user.
Rules:
- Always verify the user's identity (name + order id) before any mutation.
- Never invent order ids or emails.
- If a request is outside your tools, say so honestly.
- Be concise.`;

function retailSeed(): WorldState {
  return {
    users: {
      u_ari: { name: "Ari Chen", email: "ari@example.com" },
      u_bo: { name: "Bo Wang", email: "bo@example.com" },
      u_cai: { name: "Cai Lin", email: "cai@example.com" },
      u_dev: { name: "Dev Patel", email: "dev@example.com" },
    },
    orders: {
      o_1001: {
        userId: "u_ari",
        status: "shipped",
        address: "1 Elm St, SF, CA 94110",
        item: "wool sweater M",
        price: 89.0,
      },
      o_1002: {
        userId: "u_bo",
        status: "processing",
        address: "22 Oak Rd, NYC, NY 10001",
        item: "running shoes 10",
        price: 140.0,
      },
      o_1003: {
        userId: "u_cai",
        status: "delivered",
        address: "9 Pine Ave, Austin, TX 78701",
        item: "desk lamp",
        price: 55.0,
      },
      o_1004: {
        userId: "u_dev",
        status: "processing",
        address: "4 Maple Ln, Seattle, WA 98101",
        item: "kettle",
        price: 45.0,
      },
      o_1005: {
        userId: "u_ari",
        status: "delivered",
        address: "1 Elm St, SF, CA 94110",
        item: "notebook pack",
        price: 22.0,
      },
    },
    refunds: {},
  };
}

const lookupOrder: ToolFactory = (db) => ({
  name: "lookup_order",
  description: "Look up an order by id. Returns { userId, status, address, item, price } or null.",
  parameters: {
    type: "object",
    properties: { orderId: { type: "string" } },
    required: ["orderId"],
  },
  fn: ({ orderId }: { orderId: string }) => {
    const row = getRow(db, "orders", orderId);
    return row ? { orderId, ...row } : { error: "order not found" };
  },
});

const lookupUser: ToolFactory = (db) => ({
  name: "lookup_user",
  description: "Look up a user by id. Returns { name, email } or error.",
  parameters: {
    type: "object",
    properties: { userId: { type: "string" } },
    required: ["userId"],
  },
  fn: ({ userId }: { userId: string }) => {
    const row = getRow(db, "users", userId);
    return row ? { userId, ...row } : { error: "user not found" };
  },
});

const updateAddress: ToolFactory = (db) => ({
  name: "update_address",
  description:
    "Update the shipping address on an order. Only allowed if status is 'processing'. Returns ok/error.",
  parameters: {
    type: "object",
    properties: {
      orderId: { type: "string" },
      address: { type: "string" },
    },
    required: ["orderId", "address"],
  },
  fn: ({ orderId, address }: { orderId: string; address: string }) => {
    const row = getRow(db, "orders", orderId);
    if (!row) return { error: "order not found" };
    if (row.status !== "processing") return { error: `cannot edit: status=${row.status}` };
    setField(db, "orders", orderId, "address", address);
    return { ok: true, orderId, newAddress: address };
  },
});

const cancelOrder: ToolFactory = (db) => ({
  name: "cancel_order",
  description: "Cancel an order. Only allowed if status is 'processing'. Returns ok/error.",
  parameters: {
    type: "object",
    properties: { orderId: { type: "string" } },
    required: ["orderId"],
  },
  fn: ({ orderId }: { orderId: string }) => {
    const row = getRow(db, "orders", orderId);
    if (!row) return { error: "order not found" };
    if (row.status !== "processing") return { error: `cannot cancel: status=${row.status}` };
    setField(db, "orders", orderId, "status", "cancelled");
    return { ok: true, orderId, status: "cancelled" };
  },
});

const refundOrder: ToolFactory = (db) => ({
  name: "refund_order",
  description:
    "Issue a refund on a delivered order. Records an entry in refunds. Returns ok/error.",
  parameters: {
    type: "object",
    properties: {
      orderId: { type: "string" },
      reason: { type: "string" },
    },
    required: ["orderId", "reason"],
  },
  fn: ({ orderId, reason }: { orderId: string; reason: string }) => {
    const row = getRow(db, "orders", orderId);
    if (!row) return { error: "order not found" };
    if (row.status !== "delivered") return { error: `cannot refund: status=${row.status}` };
    db.refunds[orderId] = { orderId, reason, amount: row.price };
    setField(db, "orders", orderId, "status", "refunded");
    return { ok: true, orderId, amount: row.price };
  },
});

const listUserOrders: ToolFactory = (db) => ({
  name: "list_user_orders",
  description: "List every order belonging to a userId. Returns an array of orders.",
  parameters: {
    type: "object",
    properties: { userId: { type: "string" } },
    required: ["userId"],
  },
  fn: ({ userId }: { userId: string }) => {
    const all = db.orders ?? {};
    const out: unknown[] = [];
    for (const [orderId, row] of Object.entries(all)) {
      if (row.userId === userId) out.push({ orderId, ...row });
    }
    return out;
  },
});

const ALL_TOOLS = [
  lookupOrder,
  lookupUser,
  updateAddress,
  cancelOrder,
  refundOrder,
  listUserOrders,
];

export const TASKS: TaskDefinition[] = [
  {
    id: "t01_address_happy",
    description: "User wants to change the shipping address of a processing order.",
    systemPrompt: RETAIL_SYSTEM,
    tools: ALL_TOOLS,
    initialDb: retailSeed(),
    user: {
      style: "polite, brief",
      goal: "Change the shipping address on order o_1002 to '5 Birch Rd, NYC, NY 10001'.",
      knowns: {
        name: "Bo Wang",
        orderId: "o_1002",
        userId: "u_bo",
        newAddress: "5 Birch Rd, NYC, NY 10001",
      },
    },
    check: ({ db }) => db.orders.o_1002?.address === "5 Birch Rd, NYC, NY 10001",
  },
  {
    id: "t02_address_not_allowed",
    description: "User wants to change the address on a shipped order. Agent should refuse.",
    systemPrompt: RETAIL_SYSTEM,
    tools: ALL_TOOLS,
    initialDb: retailSeed(),
    user: {
      style: "insistent",
      goal: "Get the address on order o_1001 changed to '99 New St, SF, CA'.",
      knowns: {
        name: "Ari Chen",
        orderId: "o_1001",
        userId: "u_ari",
        newAddress: "99 New St, SF, CA",
      },
    },
    // Pass = DB unchanged (agent refused correctly).
    check: ({ db }) => db.orders.o_1001?.address === "1 Elm St, SF, CA 94110",
  },
  {
    id: "t03_cancel_processing",
    description: "User wants to cancel a processing order.",
    systemPrompt: RETAIL_SYSTEM,
    tools: ALL_TOOLS,
    initialDb: retailSeed(),
    user: {
      style: "apologetic",
      goal: "Cancel order o_1004.",
      knowns: { name: "Dev Patel", orderId: "o_1004", userId: "u_dev" },
    },
    check: ({ db }) => db.orders.o_1004?.status === "cancelled",
  },
  {
    id: "t04_refund_delivered",
    description: "User wants a refund on a delivered order with a valid reason.",
    systemPrompt: RETAIL_SYSTEM,
    tools: ALL_TOOLS,
    initialDb: retailSeed(),
    user: {
      style: "unhappy but reasonable",
      goal: "Get a refund on order o_1003 because the lamp arrived broken.",
      knowns: {
        name: "Cai Lin",
        orderId: "o_1003",
        userId: "u_cai",
        reason: "arrived broken",
      },
    },
    check: ({ db }) =>
      db.orders.o_1003?.status === "refunded" && db.refunds.o_1003?.amount === 55.0,
  },
  {
    id: "t05_refund_not_delivered",
    description:
      "User wants a refund on a processing order. Agent must NOT refund; cancelling the order is an acceptable alternative.",
    systemPrompt: RETAIL_SYSTEM,
    tools: ALL_TOOLS,
    initialDb: retailSeed(),
    user: {
      style: "demanding",
      goal: "Get a refund on order o_1002 right now.",
      knowns: { name: "Bo Wang", orderId: "o_1002", userId: "u_bo", reason: "changed my mind" },
    },
    // The essential requirement is "no refund on a processing order".
    // Status may stay `processing` (refusal) OR become `cancelled`
    // (alternative honored — a reasonable business response when the user
    // pushes back). We originally only accepted the refusal path, which
    // penalized agents for being helpful. Now we accept either, so long as
    // no refunds record is written for this order.
    check: ({ db }) => {
      const status = db.orders.o_1002?.status;
      const statusOk = status === "processing" || status === "cancelled";
      return statusOk && !db.refunds.o_1002;
    },
  },
  {
    id: "t06_multi_order_lookup",
    description: "User wants to hear their full order history, then cancels one.",
    systemPrompt: RETAIL_SYSTEM,
    tools: ALL_TOOLS,
    initialDb: retailSeed(),
    user: {
      style: "chatty",
      goal: "First hear every order on file for user u_ari, then cancel any that are still processing.",
      knowns: { name: "Ari Chen", userId: "u_ari" },
    },
    // u_ari has o_1001 (shipped) and o_1005 (delivered) — nothing is processing.
    // Pass = both of Ari's orders unchanged.
    check: ({ db }) =>
      db.orders.o_1001?.status === "shipped" && db.orders.o_1005?.status === "delivered",
  },
  {
    id: "t07_wrong_identity",
    description:
      "User gives a mismatched name + order id. Agent should not mutate on unverified identity.",
    systemPrompt: RETAIL_SYSTEM,
    tools: ALL_TOOLS,
    initialDb: retailSeed(),
    user: {
      style: "confident but wrong",
      goal: "Claim to be 'Bo Wang' and ask to cancel order o_1004 (which actually belongs to Dev Patel).",
      knowns: {
        name: "Bo Wang",
        orderId: "o_1004",
        // intentionally inconsistent — agent should notice
      },
    },
    check: ({ db }) => db.orders.o_1004?.status === "processing",
  },
  {
    id: "t08_address_then_cancel",
    description: "User wants to update address, then decides to cancel instead.",
    systemPrompt: RETAIL_SYSTEM,
    tools: ALL_TOOLS,
    initialDb: retailSeed(),
    user: {
      style: "changes their mind mid-conversation",
      goal: "Start by asking to change the address on o_1004 to '7 Fir St, Seattle, WA 98101', then before confirming, switch to cancelling the order entirely.",
      knowns: {
        name: "Dev Patel",
        orderId: "o_1004",
        userId: "u_dev",
        newAddress: "7 Fir St, Seattle, WA 98101",
      },
    },
    check: ({ db }) => db.orders.o_1004?.status === "cancelled",
  },
];
