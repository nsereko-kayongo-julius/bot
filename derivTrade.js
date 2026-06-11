function sendDerivRequest(ws, payload) {
  return new Promise((resolve, reject) => {
    const reqId = Math.floor(Math.random() * 1000000000);

    const request = {
      ...payload,
      req_id: reqId,
    };

    const onMessage = (data) => {
      const msg = JSON.parse(data);

      if (msg.req_id !== reqId) {
        return;
      }

      ws.off("message", onMessage);

      if (msg.error) {
        reject(msg.error);
        return;
      }

      resolve(msg);
    };

    ws.on("message", onMessage);
    ws.send(JSON.stringify(request));
  });
}

async function requestProposal(ws, signal, config = {}) {
  const stake = Number(config.stake || 1);
  const currency = config.currency || "USD";
  const symbol = config.symbol;
  const multiplier = Number(config.multiplier || 100);

  const contractType = signal.action === "buy" ? "MULTUP" : "MULTDOWN";

  const proposalRequest = {
    proposal: 1,
    amount: stake,
    basis: "stake",
    contract_type: contractType,
    currency,
    multiplier,
    symbol,
  };

  console.log("Requesting Deriv proposal:");
  console.log(proposalRequest);

  const response = await sendDerivRequest(ws, proposalRequest);

  console.log("Deriv proposal received:");
  console.log(response.proposal);

  return response.proposal;
}

module.exports = {
  sendDerivRequest,
  requestProposal,
};
