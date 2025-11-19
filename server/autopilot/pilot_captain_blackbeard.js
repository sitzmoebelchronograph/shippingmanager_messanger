/**
 * @fileoverview Captain Blackbeard - Auto-Negotiate Hijacking Pilot
 *
 * Automatically negotiates hijacked vessels.
 * Offers 1% repeatedly until price is below $20,000, then accepts.
 *
 * @module server/autopilot/pilot_captain_blackbeard
 */

const state = require('../state');
const logger = require('../utils/logger');
const { getUserId, apiCall } = require('../utils/api');
const path = require('path');
const fs = require('fs');
const { auditLog, CATEGORIES, SOURCES, formatCurrency } = require('../utils/audit-logger');

/**
 * Get hijacking case data with retry logic.
 */
async function getCaseWithRetry(caseId, maxRetries) {
  const { getCachedHijackingCase } = require('../websocket');

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await getCachedHijackingCase(caseId);
      if (result && result.details) {
        return result.details;
      }
      logger.debug(`[Auto-Negotiate Hijacking] Get case attempt ${attempt}/${maxRetries}: No data`);
    } catch (error) {
      logger.debug(`[Auto-Negotiate Hijacking] Get case attempt ${attempt}/${maxRetries}: ${error.message}`);
    }
    if (attempt < maxRetries) {
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
  return null;
}

/**
 * Submit negotiation offer with retry logic.
 */
async function submitOfferWithRetry(userId, caseId, amount, maxRetries) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await apiCall('/hijacking/submit-offer', 'POST', {
        case_id: caseId,
        amount: amount
      });
      if (response) {
        // Save bot's offer to history immediately
        try {
          const { getAppDataDir } = require('../config');
          const historyDir = path.join(
            getAppDataDir(),
            'ShippingManagerCoPilot',
            'data',
            'hijack_history'
          );
          const historyPath = path.join(historyDir, `${userId}-${caseId}.json`);

          if (!fs.existsSync(historyDir)) {
            fs.mkdirSync(historyDir, { recursive: true });
          }

          let historyData = [];
          let autopilotResolved = false;
          let resolvedAt = null;
          if (fs.existsSync(historyPath)) {
            const existingData = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
            historyData = Array.isArray(existingData) ? existingData : existingData.history;
            autopilotResolved = existingData.autopilot_resolved;
            resolvedAt = existingData.resolved_at;
          }

          historyData.push({
            type: 'user',
            amount: amount,
            timestamp: Date.now() / 1000
          });

          const updatedHistory = {
            history: historyData,
            autopilot_resolved: autopilotResolved,
            resolved_at: resolvedAt
          };

          fs.writeFileSync(historyPath, JSON.stringify(updatedHistory, null, 2));
          logger.debug(`[Auto-Negotiate Hijacking] Case ${caseId}: Bot offer $${amount} saved to history`);
        } catch (error) {
          logger.debug(`[Auto-Negotiate Hijacking] Case ${caseId}: Failed to save bot offer to history:`, error);
        }

        return true;
      }
      logger.debug(`[Auto-Negotiate Hijacking] Submit offer attempt ${attempt}/${maxRetries}: No response`);
    } catch (error) {
      logger.debug(`[Auto-Negotiate Hijacking] Submit offer attempt ${attempt}/${maxRetries}: ${error.message}`);
    }
    if (attempt < maxRetries) {
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
  return false;
}

/**
 * Accept ransom with retry logic and cash verification.
 *
 * Cash verification formula:
 * cash_before_paid - requested_amount === paymentResponse.user.cash
 *
 * If equal → "blackbeard"
 * If not equal → "failed"
 */
async function acceptRansomWithRetry(caseId, expectedAmount, cashBeforePaid, maxRetries) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await apiCall('/hijacking/pay', 'POST', { case_id: caseId });
      if (response) {
        // Get cash AFTER payment directly from payment response
        const cashAfterPaid = response.user?.cash;

        // Verification: cash_before_paid - requested_amount === cashAfterPaid
        const expectedCashAfter = cashBeforePaid - expectedAmount;
        const verified = (expectedCashAfter === cashAfterPaid);
        const verificationStatus = verified ? 'blackbeard' : 'failed';

        logger.debug(`[Auto-Negotiate Hijacking] Case ${caseId}: Payment verification - Cash Before: $${cashBeforePaid}, Requested: $${expectedAmount}, Expected Cash After: $${expectedCashAfter}, Actual Cash After: $${cashAfterPaid}, Status: ${verificationStatus}`);

        return {
          success: true,
          verified: verified,
          verification_status: verificationStatus,
          expected_amount: expectedAmount,
          cash_before_paid: cashBeforePaid,
          cash_after_paid: cashAfterPaid,
          expected_cash_after: expectedCashAfter
        };
      }
      logger.debug(`[Auto-Negotiate Hijacking] Accept ransom attempt ${attempt}/${maxRetries}: No response`);
    } catch (error) {
      logger.debug(`[Auto-Negotiate Hijacking] Accept ransom attempt ${attempt}/${maxRetries}: ${error.message}`);
    }
    if (attempt < maxRetries) {
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
  return null;
}

/**
 * Process a single hijacking case: make max counter offers, then accept.
 */
async function processHijackingCase(userId, caseId, vesselName, offerPercentage, maxCounterOffers, verifyDelay, maxRetries, broadcastToUser) {
  logger.debug(`[Auto-Negotiate Hijacking] Processing case ${caseId}...`);

  let negotiationRound = 0;
  let counterOffersMade = 0;
  let initialDemand = null;
  const MAX_ROUNDS = 50;

  while (negotiationRound < MAX_ROUNDS) {
    negotiationRound++;

    const caseData = await getCaseWithRetry(caseId, maxRetries);
    if (!caseData) {
      logger.debug(`[Auto-Negotiate Hijacking] Case ${caseId}: Failed to get case data, aborting`);
      return;
    }

    const requestedAmount = caseData.requested_amount;
    const status = caseData.status;

    logger.debug(`[Auto-Negotiate Hijacking] Case ${caseId} Round ${negotiationRound}: Status="${status}", Price=$${requestedAmount}`);

    // Capture initial demand on first round
    if (negotiationRound === 1) {
      initialDemand = requestedAmount;
    }

    // Save initial pirate demand to history
    if (negotiationRound === 1) {
      try {
        const { getAppDataDir } = require('../config');
        const historyDir = path.join(
          getAppDataDir(),
          'ShippingManagerCoPilot',
          'data',
          'hijack_history'
        );
        const historyPath = path.join(historyDir, `${userId}-${caseId}.json`);

        if (!fs.existsSync(historyDir)) {
          fs.mkdirSync(historyDir, { recursive: true });
        }

        if (!fs.existsSync(historyPath)) {
          const initialHistory = {
            history: [{
              type: 'pirate',
              amount: requestedAmount,
              timestamp: Date.now() / 1000
            }],
            autopilot_resolved: false,
            resolved_at: null
          };

          fs.writeFileSync(historyPath, JSON.stringify(initialHistory, null, 2));
          logger.debug(`[Auto-Negotiate Hijacking] Case ${caseId}: Initial pirate demand $${requestedAmount} saved to history`);
        }
      } catch (error) {
        logger.debug(`[Auto-Negotiate Hijacking] Case ${caseId}: Failed to save initial demand to history:`, error);
      }
    }

    // Broadcast current price
    if (broadcastToUser) {
      broadcastToUser(userId, 'hijacking_update', {
        action: 'price_check',
        data: {
          case_id: caseId,
          round: negotiationRound,
          current_price: requestedAmount,
          status: status
        }
      });
    }

    // Check if already resolved
    if (status === 'solved' || status === 'paid') {
      logger.debug(`[Auto-Negotiate Hijacking] Case ${caseId}: Already resolved (status="${status}"), stopping`);
      return;
    }

    // Check for $0 bug
    if (requestedAmount === 0) {
      logger.error(`[Auto-Negotiate Hijacking] Case ${caseId}: CRITICAL BUG - Price is $0`);
      logger.warn(`[Auto-Negotiate Hijacking] Case ${caseId}: Attempting to fix by submitting new offers (max 3 attempts)...`);

      let fixAttempts = 0;
      const MAX_FIX_ATTEMPTS = 3;

      while (fixAttempts < MAX_FIX_ATTEMPTS) {
        fixAttempts++;
        const fixOfferAmount = 100;
        logger.debug(`[Auto-Negotiate Hijacking] Case ${caseId}: Fix attempt ${fixAttempts}/${MAX_FIX_ATTEMPTS}: Offering $${fixOfferAmount}`);

        const offered = await submitOfferWithRetry(userId, caseId, fixOfferAmount, maxRetries);
        if (!offered) {
          logger.debug(`[Auto-Negotiate Hijacking] Case ${caseId}: Failed to submit fix offer`);
          continue;
        }

        await new Promise(resolve => setTimeout(resolve, verifyDelay));

        const fixedCase = await getCaseWithRetry(caseId, maxRetries);
        if (fixedCase && fixedCase.requested_amount > 0) {
          logger.info(`[Auto-Negotiate Hijacking] Case ${caseId}: OK Bug fixed! New price: $${fixedCase.requested_amount}`);
          break;
        }

        logger.debug(`[Auto-Negotiate Hijacking] Case ${caseId}: Price still $0 after attempt ${fixAttempts}`);
      }

      const recheckCase = await getCaseWithRetry(caseId, maxRetries);
      if (!recheckCase || recheckCase.requested_amount === 0) {
        logger.error(`[Auto-Negotiate Hijacking] Case ${caseId}: Unable to fix $0 bug, ABORTING`);

        if (broadcastToUser) {
          broadcastToUser(userId, 'hijacking_update', {
            action: 'negotiation_failed',
            data: { case_id: caseId }
          });
        }
        return;
      }

      logger.debug(`[Auto-Negotiate Hijacking] Case ${caseId}: Continuing with valid price $${recheckCase.requested_amount}`);
      continue;
    }

    // Check if we should accept (reached max counter offers)
    const shouldAccept = counterOffersMade >= maxCounterOffers;

    if (shouldAccept) {
      logger.debug(`[Auto-Negotiate Hijacking] Case ${caseId}: Reached max counter offers (${counterOffersMade}/${maxCounterOffers}), accepting price $${requestedAmount}, checking cash...`);

      // Get cash BEFORE payment from current case data
      const cashBeforePaid = caseData.user?.cash;

      if (cashBeforePaid < requestedAmount) {
        logger.warn(`[Auto-Negotiate Hijacking] Case ${caseId}: INSUFFICIENT FUNDS - Need $${requestedAmount}, have $${cashBeforePaid}`);

        if (broadcastToUser) {
          broadcastToUser(userId, 'hijacking_update', {
            action: 'insufficient_funds',
            data: {
              case_id: caseId,
              vessel_name: vesselName,
              required: requestedAmount,
              available: cashBeforePaid
            }
          });
        }
        return;
      }

      logger.debug(`[Auto-Negotiate Hijacking] Case ${caseId}: Cash OK ($${cashBeforePaid}), ACCEPTING ransom of $${requestedAmount}`);

      if (broadcastToUser) {
        broadcastToUser(userId, 'hijacking_update', {
          action: 'accepting_price',
          data: {
            case_id: caseId,
            final_price: requestedAmount,
            counter_offers_made: counterOffersMade
          }
        });
      }

      const paymentResult = await acceptRansomWithRetry(caseId, requestedAmount, cashBeforePaid, maxRetries);
      if (paymentResult && paymentResult.success) {
        logger.info(`[Auto-Negotiate Hijacking] Case ${caseId}: SOLVED - Vessel released`);

        // Mark as autopilot-resolved
        try {
          const { getAppDataDir } = require('../config');
          const historyDir = path.join(
            getAppDataDir(),
            'ShippingManagerCoPilot',
            'data',
            'hijack_history'
          );
          const historyPath = path.join(historyDir, `${userId}-${caseId}.json`);

          if (!fs.existsSync(historyDir)) {
            fs.mkdirSync(historyDir, { recursive: true });
          }

          let historyData = [];
          if (fs.existsSync(historyPath)) {
            const existingData = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
            historyData = Array.isArray(existingData) ? existingData : existingData.history;
          }

          const updatedHistory = {
            history: historyData,
            autopilot_resolved: true,
            resolved_at: Date.now() / 1000,
            payment_verification: {
              verified: paymentResult.verified,
              verification_status: paymentResult.verification_status,
              expected_amount: paymentResult.expected_amount,
              cash_before_paid: paymentResult.cash_before_paid,
              cash_after_paid: paymentResult.cash_after_paid,
              expected_cash_after: paymentResult.expected_cash_after
            }
          };

          fs.writeFileSync(historyPath, JSON.stringify(updatedHistory, null, 2));
          logger.debug(`[Auto-Negotiate Hijacking] Case ${caseId}: Marked as autopilot-resolved with status: ${paymentResult.verification_status}`);
        } catch (error) {
          logger.debug(`[Auto-Negotiate Hijacking] Case ${caseId}: Failed to mark as autopilot-resolved:`, error);
        }

        if (broadcastToUser) {
          broadcastToUser(userId, 'hijacking_update', {
            action: 'hijacking_resolved',
            data: {
              case_id: caseId,
              final_amount: requestedAmount,
              vessel_name: vesselName,
              success: true,
              payment_verified: paymentResult.verified,
              verification_status: paymentResult.verification_status
            }
          });
        }

        // Log to autopilot logbook
        await auditLog(
          userId,
          CATEGORIES.HIJACKING,
          'Auto-Blackbeard',
          `${vesselName} | ${formatCurrency(requestedAmount)}`,
          {
            caseId,
            vesselName,
            initialDemand: initialDemand || requestedAmount,
            finalPayment: requestedAmount,
            negotiationRounds: negotiationRound,
            verified: paymentResult.verified,
            verificationStatus: paymentResult.verification_status
          },
          'SUCCESS',
          SOURCES.AUTOPILOT
        );
      } else {
        logger.debug(`[Auto-Negotiate Hijacking] Case ${caseId}: Failed to accept ransom`);
      }
      return;
    }

    // Make counter offer (25% of requested amount)
    counterOffersMade++;
    const offerAmount = Math.floor(requestedAmount * offerPercentage);
    logger.debug(`[Auto-Negotiate Hijacking] Case ${caseId}: Counter offer ${counterOffersMade}/${maxCounterOffers}: Offering $${offerAmount} (${offerPercentage * 100}%)`);

    if (broadcastToUser) {
      broadcastToUser(userId, 'hijacking_update', {
        action: 'offer_submitted',
        data: {
          case_id: caseId,
          round: negotiationRound,
          counter_offer_number: counterOffersMade,
          max_counter_offers: maxCounterOffers,
          your_offer: offerAmount,
          pirate_demand: requestedAmount
        }
      });
    }

    const offered = await submitOfferWithRetry(userId, caseId, offerAmount, maxRetries);
    if (!offered) {
      logger.debug(`[Auto-Negotiate Hijacking] Case ${caseId}: Failed to submit offer, aborting`);
      return;
    }

    logger.debug(`[Auto-Negotiate Hijacking] Case ${caseId}: Waiting ${verifyDelay}ms for API to process...`);
    await new Promise(resolve => setTimeout(resolve, verifyDelay));

    const verifiedCase = await getCaseWithRetry(caseId, maxRetries);
    if (!verifiedCase) {
      logger.debug(`[Auto-Negotiate Hijacking] Case ${caseId}: Failed to verify offer, aborting`);
      return;
    }

    const newRequestedAmount = verifiedCase.requested_amount;
    const priceChanged = (newRequestedAmount !== requestedAmount);

    if (priceChanged) {
      logger.debug(`[Auto-Negotiate Hijacking] Case ${caseId}: OK Offer processed, new price: $${newRequestedAmount}`);
    } else {
      logger.debug(`[Auto-Negotiate Hijacking] Case ${caseId}: Price unchanged at $${newRequestedAmount}`);
    }

    // ALWAYS save pirate counter-offer to log (even if price unchanged)
    // This is the pirate's response after we made our offer
    try {
      const { getAppDataDir } = require('../config');
      const historyDir = path.join(
        getAppDataDir(),
        'ShippingManagerCoPilot',
        'data',
        'hijack_history'
      );
      const historyPath = path.join(historyDir, `${userId}-${caseId}.json`);

      let historyData = [];
      let autopilotResolved = false;
      let resolvedAt = null;
      if (fs.existsSync(historyPath)) {
        const existingData = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
        historyData = Array.isArray(existingData) ? existingData : existingData.history;
        autopilotResolved = existingData.autopilot_resolved;
        resolvedAt = existingData.resolved_at;
      }

      historyData.push({
        type: 'pirate',
        amount: newRequestedAmount,
        timestamp: Date.now() / 1000
      });

      const updatedHistory = {
        history: historyData,
        autopilot_resolved: autopilotResolved,
        resolved_at: resolvedAt
      };

      fs.writeFileSync(historyPath, JSON.stringify(updatedHistory, null, 2));
      logger.debug(`[Auto-Negotiate Hijacking] Case ${caseId}: Pirate counter $${newRequestedAmount} saved to log`);
    } catch (error) {
      logger.debug(`[Auto-Negotiate Hijacking] Case ${caseId}: Failed to save pirate counter:`, error);
    }

    if (broadcastToUser && priceChanged) {
      broadcastToUser(userId, 'hijacking_update', {
        action: 'pirate_counter_offer',
        data: {
          case_id: caseId,
          round: negotiationRound,
          your_offer: offerAmount,
          pirate_counter: newRequestedAmount,
          old_price: requestedAmount
        }
      });
    }
  }

  logger.warn(`[Auto-Negotiate Hijacking] Case ${caseId}: Reached maximum rounds (${MAX_ROUNDS})`);

  if (broadcastToUser) {
    broadcastToUser(null, {
      type: 'hijacking_update',
      action: 'negotiation_failed',
      data: { case_id: caseId }
    });
  }
}

/**
 * Automatically negotiates hijacked vessels.
 */
async function autoNegotiateHijacking(autopilotPaused, broadcastToUser, tryUpdateAllData) {
  if (autopilotPaused) {
    logger.debug('[Auto-Negotiate Hijacking] Skipped - Autopilot is PAUSED');
    return;
  }

  const userId = getUserId();
  if (!userId) return;

  const settings = state.getSettings(userId);
  if (!settings.autoNegotiateHijacking) {
    logger.debug('[Auto-Negotiate Hijacking] Feature disabled in settings');
    return;
  }

  const OFFER_PERCENTAGE = 0.25;
  const MAX_COUNTER_OFFERS = 2;
  const VERIFY_DELAY = 120000;
  const MAX_RETRIES = 3;

  try {
    const { getCachedMessengerChats } = require('../websocket');
    const chats = await getCachedMessengerChats();

    if (!chats || chats.length === 0) {
      logger.debug('[Auto-Negotiate Hijacking] No messages data');
      return;
    }

    const hijackingChats = chats.filter(chat => {
      return chat.body === 'vessel_got_hijacked';
    });

    if (hijackingChats.length === 0) {
      logger.debug('[Auto-Negotiate Hijacking] No active hijacking cases');
      return;
    }

    logger.debug(`[Auto-Negotiate Hijacking] Found ${hijackingChats.length} active case(s)`);

    let processed = 0;
    for (const chat of hijackingChats) {
      const caseId = chat.values?.case_id;
      const vesselName = chat.values?.vessel_name || 'Unknown Vessel';

      if (!caseId) {
        logger.debug('[Auto-Negotiate Hijacking] Case missing ID, skipping');
        continue;
      }

      try {
        await processHijackingCase(userId, caseId, vesselName, OFFER_PERCENTAGE, MAX_COUNTER_OFFERS, VERIFY_DELAY, MAX_RETRIES, broadcastToUser);
        processed++;
      } catch (error) {
        logger.error(`[Auto-Negotiate Hijacking] Error processing case ${caseId}:`, error.message);

        // Log error to autopilot logbook
        await auditLog(
          userId,
          CATEGORIES.HIJACKING,
          'Auto-Blackbeard',
          `Negotiation failed for ${vesselName}: ${error.message}`,
          {
            caseId,
            vesselName,
            error: error.message,
            stack: error.stack
          },
          'ERROR',
          SOURCES.AUTOPILOT
        );

        if (broadcastToUser) {
          broadcastToUser(userId, 'hijacking_update', {
            action: 'negotiation_failed',
            data: { case_id: caseId }
          });
        }
      }
    }

    if (processed > 0) {
      await tryUpdateAllData();
    }

  } catch (error) {
    logger.error('[Auto-Negotiate Hijacking] Error:', error.message);

    // Log error to autopilot logbook
    await auditLog(
      userId,
      CATEGORIES.HIJACKING,
      'Auto-Blackbeard',
      `Operation failed: ${error.message}`,
      {
        error: error.message,
        stack: error.stack
      },
      'ERROR',
      SOURCES.AUTOPILOT
    );
  }
}

module.exports = {
  autoNegotiateHijacking
};
