import harden from '@agoric/harden';
import { E } from '@agoric/eventual-send';

export default harden(({brands, zoe, registrar, http, overrideInstanceId = undefined}, _inviteMaker) => {
  // If we have an overrideInstanceId, use it to assert the correct value in the RPC.
  function coerceInstanceId(instanceId = undefined) {
    if (instanceId === undefined) {
      return overrideInstanceId;
    }
    if (overrideInstanceId === undefined || instanceId === overrideInstanceId) {
      return instanceId;
    }
    throw TypeError(`instanceId ${JSON.stringify(instanceId)} must match ${JSON.stringify(overrideInstanceId)}`);
  }

  const brandToBrandRegKey = new Map();
  Object.entries(brands).forEach(([brandRegKey, brand]) =>
    brandToBrandRegKey.set(brand, brandRegKey));

  const registrarPCache = new Map();
  function getRegistrarP(id) {
    let regP = registrarPCache.get(id);
    if (!regP) {
      // Cache miss, so try the registrar.
      regP = E(registrar).get(id);
      registrarPCache.set(id, regP);
    }
    return regP;
  }

  const instancePCache = new Map();
  function getInstanceP(id) {
    let instanceP = instancePCache.get(id);
    if (!instanceP) {
      const instanceHandleP = getRegistrarP(id);
      instanceP = instanceHandleP.then(instanceHandle =>
        E(zoe).getInstance(instanceHandle));
      instancePCache.set(id, instanceP);
    }
    return instanceP;
  }

  async function getJSONBookOrders(instanceRegKey) {
    const { publicAPI } = await getInstanceP(instanceRegKey);
    const rawBookOrders = await E(publicAPI).getBookOrders();
    const bookOrders = { changed: rawBookOrders.changed };
    const jsonAmount = ({ extent, brand }) =>
      ({ extent, brandRegKey: brandToBrandRegKey.get(brand) });
    const jsonOrders = orders => orders.map(({ publicID, Asset, Price }) =>
      ({ publicID, Asset: jsonAmount(Asset), Price: jsonAmount(Price) }));
    bookOrders.buy = jsonOrders(rawBookOrders.buy);
    bookOrders.sell = jsonOrders(rawBookOrders.sell);
    return bookOrders;
  }

  const instanceToRecentOrders = new Map();
  const loadingOrders = new Map();
  const subscribers = new Map();
  function updateRecentOrdersOnChange(instanceRegKey, recentOrders) {
    // Save the recent order.
    instanceToRecentOrders.set(instanceRegKey, recentOrders);

    // Resubscribe.
    recentOrders.changed
      .then(() => getJSONBookOrders(instanceRegKey))
      .then(order => updateRecentOrdersOnChange(instanceRegKey, order));

    // Publish to our subscribers.
    const subs = subscribers.get(instanceRegKey);
    if (!subs) {
      return;
    }

    const { buy, sell } = recentOrders;
    const obj = {
      type: 'simpleExchange/recentOrders',
      data: { buy, sell },
    };

    E(http).send(obj, [...subs.keys()])
      .catch(e => console.error('cannot send for', instanceRegKey, e));
  }

  function ensureRecentOrdersSubscription(instanceRegKey) {
    let loadingP = loadingOrders.get(instanceRegKey);
    if (loadingP) {
      return loadingP;
    }

    // Start the subscription.
    const pr = makePromise();
    loadingOrders.set(instanceRegKey, pr.p);
    loadingP = pr.p;
    getJSONBookOrders(instanceRegKey).then(order => {
      updateRecentOrdersOnChange(instanceRegKey, order);
      pr.res();
    }, pr.rej);

    loadingP.catch(e => console.error('Error loading', instanceRegKey, e));
    return loadingP;
  }

  async function getRecentOrders(instanceRegKey) {
    await ensureRecentOrdersSubscription(instanceRegKey);
    return instanceToRecentOrders.get(instanceRegKey);
  }

  function subscribeRecentOrders(instanceRegKey, channelHandle) {
    ensureRecentOrdersSubscription(instanceRegKey);
    let subs = subscribers.get(instanceRegKey);
    if (!subs) {
      subs = new Set();
      subscribers.set(instanceRegKey, subs);
    }
    subs.add(channelHandle);
    return true;
  }

  if (overrideInstanceId) {
    ensureRecentOrdersSubscription(overrideInstanceId)
      .catch(e => console.error('cannot subscribe to', overrideInstanceId, e));
  }

  return harden({
    getCommandHandler() {
      const handler = {
        onOpen(_obj, { channelHandle }) {
          subscribedInstances.set(channelHandle, new Set());
        },
        onClose(_obj, { channelHandle }) {
          const instances = subscribedInstances.get(channelHandle);
          for (const instanceId of instances.keys()) {
            const subs = subscribers.get(instanceId);
            if (subs) {
              // Clean up the subscriptions from the list.
              subs.delete(channelHandle);
            }
          }
          subscribedInstances.delete(channelHandle);
        },
        processInbound(obj) {
          // FIXME: Remove when multicast is merged.
          return handler.onMessage(obj);
        },
        async onMessage(obj, { channelHandle } = {}) {
          switch (obj.type) {
            case 'simpleExchange/getRecentOrders': {
              const { instanceRegKey } = obj;
              const instanceId = coerceInstanceId(instanceRegKey);

              const { buy, sell } = await getRecentOrders(instanceId);

              return harden({
                type: 'simpleExchange/recentOrders',
                data: { buy, sell },
              });
            }

            case 'simpleExchange/subscribeRecentOrders': {
              const { instanceRegKey } = obj;
              const instanceId = coerceInstanceId(instanceRegKey);

              if (!channel) {
                throw Error(`Channel is not set for ${instanceId} subscription`);
              }

              const subs = subscribedInstances.get(channelHandle);
              if (!subs) {
                throw Error(`Subscriptions not initialised for channel ${channelHandle}`);
              }

              if (subs.has(instanceId)) {
                return harden({
                  type: 'simpleExchange/subscribedToRecentOrders',
                  data: 'already',
                });
              }

              subs.add(instanceId);
              subscribeRecentOrders(instanceId, channelHandle);

              return harden({
                type: 'simpleExchange/subscribedToRecentOrders',
                data: true,
              });
            }

            default:
              return undefined;
          }
        },
      };
      return harden(handler);
    },
  });
});
