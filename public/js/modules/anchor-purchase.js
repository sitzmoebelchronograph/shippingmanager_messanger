/**
 * Anchor Point Purchase Dialog - Instant completion via reset-timing exploit
 * Uses overlay window like vessel catalog for consistent UX
 */

import { showSideNotification } from './utils.js';

// Module-level variables for timer synchronization across tabs
let moduleNextBuild = null;
let modulePendingAmount = 1;
let moduleTimerInterval = null;

export async function showAnchorPurchaseDialog() {
  const overlay = document.getElementById('anchorPurchaseOverlay');
  const feed = document.getElementById('anchorPurchaseFeed');
  const closeBtn = document.getElementById('closeAnchorPurchaseBtn');

  // Show overlay
  overlay.classList.remove('hidden');

  // Show loading state
  feed.innerHTML = `
    <div style="text-align: center; color: #9ca3af; padding: 40px;">
      Loading...
    </div>
  `;

  // Fetch current price AND anchor timer status from /game/index
  let pricePerPoint = 0;
  let userCash = 0;
  let nextBuild = moduleNextBuild;  // Use module variable
  let timerActive = false;
  let timerInterval = moduleTimerInterval;  // Use module variable
  let badgeObserver = null;  // MutationObserver for badge changes

  try {
    // Fetch price data and anchor_next_build from backend (via /game/index)
    const response = await fetch('/api/anchor/get-price');
    const data = await response.json();

    if (!data.success) {
      throw new Error(data.error || 'Failed to load price data');
    }

    pricePerPoint = data.price;
    userCash = data.cash;
    nextBuild = data.anchor_next_build;
    const buildDuration = data.duration || 0; // Build time in seconds for 1 anchor point
    moduleNextBuild = nextBuild;  // Update module variable

    // Check if timer is active
    const now = Math.floor(Date.now() / 1000);
    timerActive = nextBuild && nextBuild > now;

    // Format build time
    const formatBuildTime = (seconds) => {
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      if (hours > 0 && minutes > 0) {
        return `${hours}h ${minutes}m`;
      } else if (hours > 0) {
        return `${hours}h`;
      } else {
        return `${minutes}m`;
      }
    };

    // Render purchase form with relative positioning for overlay
      feed.innerHTML = `
        <!-- Info section - dynamically updated when badge changes -->
        <div id="anchorInfoSection"></div>

        <!-- Form section - can be covered by timer -->
        <div style="position: relative;">
          <div style="background: rgba(255, 255, 255, 0.02); padding: 16px; border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.1); margin-bottom: 4px;">
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 0 0 8px 0; margin-bottom: 8px; border-bottom: 2px solid rgba(255, 255, 255, 0.1);">
              <span style="color: #9ca3af; font-size: 14px;">Your Balance:</span>
              <span style="color: #4ade80; font-size: 16px; font-weight: 600;">$${userCash.toLocaleString()}</span>
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid rgba(255, 255, 255, 0.05);">
              <span style="color: #9ca3af; font-size: 14px;">Price per ⚓:</span>
              <span style="color: #f3f4f6; font-size: 16px; font-weight: 600;">$${pricePerPoint.toLocaleString()}</span>
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid rgba(255, 255, 255, 0.05);">
              <span style="color: #9ca3af; font-size: 14px;">Amount:</span>
              <div style="display: flex; gap: 16px;">
                <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; color: #f3f4f6; font-size: 14px;">
                  <input type="radio" name="anchorAmount" id="anchorBuy1Radio" value="1" style="cursor: pointer; width: 16px; height: 16px;">
                  <span>1</span>
                </label>
                <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; color: #f3f4f6; font-size: 14px;">
                  <input type="radio" name="anchorAmount" id="anchorBuy10Radio" value="10" style="cursor: pointer; width: 16px; height: 16px;">
                  <span>10</span>
                </label>
              </div>
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px 0 4px 0; border-bottom: 1px solid rgba(255, 255, 255, 0.05);">
              <span style="color: #e0e0e0; font-size: 15px; font-weight: 600;">Total:</span>
              <div id="anchorTotalCost" style="font-size: 20px; font-weight: 700;">$0</div>
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px 0 4px 0;">
              <span style="color: #e0e0e0; font-size: 15px; font-weight: 600;">Build Time:</span>
              <div id="anchorBuildTime" style="font-size: 16px; font-weight: 600; color: #fbbf24;">-</div>
            </div>
          </div>
          <div style="display: flex; gap: 12px;">
            <button id="anchorCancelBtn" style="flex: 1; padding: 1px 12px; background: rgba(107, 114, 128, 0.2); border: 1px solid rgba(107, 114, 128, 0.3); border-radius: 6px; color: #9ca3af; font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.2s;">Cancel</button>
            <button id="anchorPurchaseBtn" style="flex: 1; padding: 1px 12px; background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); border: none; border-radius: 6px; color: white; font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.2s;" disabled>Purchase</button>
          </div>

          ${timerActive ? `
            <!-- Timer Overlay - Blocks only form interactions -->
            <div id="anchorTimerOverlay" style="position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: rgba(17, 24, 39, 0.90); backdrop-filter: blur(6px); border-radius: 8px; display: flex; flex-direction: column; align-items: center; justify-content: center; z-index: 100; pointer-events: all; cursor: not-allowed;">
              <div style="text-align: center; padding: 16px;">
                <div style="margin-bottom: 12px;">
                  <span style="font-size: 36px;">⏳</span>
                </div>
                <p style="margin: 0 0 8px 0; color: #fbbf24; font-size: 16px; font-weight: 600;">
                  ${modulePendingAmount} Anchor Point${modulePendingAmount > 1 ? 's' : ''} Under Construction
                </p>
                <div id="anchorTimerDisplay" style="font-size: 24px; font-weight: 700; color: #fcd34d; font-family: 'Courier New', monospace; margin-bottom: 8px;">
                  --:--:--
                </div>
                <p style="margin: 0; color: #9ca3af; font-size: 13px; max-width: 280px; line-height: 1.4;">
                  Construction in progress. Purchase will be available when timer completes.
                </p>
              </div>
            </div>
          ` : ''}
        </div>
      `;

      // Setup event listeners
      const buy1Radio = document.getElementById('anchorBuy1Radio');
      const buy10Radio = document.getElementById('anchorBuy10Radio');
      const totalCostDiv = document.getElementById('anchorTotalCost');
      const cancelBtn = document.getElementById('anchorCancelBtn');

      let selectedAmount = null;

      // Get Purchase button reference
      const purchaseBtn = overlay.querySelector('#anchorPurchaseBtn');

      // Function to update info section based on current badge
      function updateInfoSection() {
        const anchorBadge = document.getElementById('anchorCount');
        const vesselsAtAnchor = parseInt(anchorBadge?.textContent) || 0;
        const infoSection = document.getElementById('anchorInfoSection');

        if (infoSection) {
          infoSection.innerHTML = vesselsAtAnchor > 0 ? `
            <div style="padding: 12px; background: rgba(59, 130, 246, 0.1); border-left: 3px solid #3b82f6; border-radius: 4px; margin-bottom: 0;">
              <p style="margin: 0; color: #93c5fd; font-size: 14px;">
                <strong>${vesselsAtAnchor}</strong> vessel${vesselsAtAnchor === 1 ? '' : 's'} currently at anchor
              </p>
            </div>

            <div style="padding-top: 1px; margin-bottom: 3px;">
              <p style="margin: 0; color: #fbbf24; font-size: 12px; line-height: 1.5;">
                💡 <strong>Reminder:</strong> Don't forget to actually play the game and set your routes manually! 😛
              </p>
            </div>

            <hr style="border: none; border-top: 1px solid rgba(255, 255, 255, 0.1); margin: 3px 0;">
          ` : '';
        }
      }

      // Initial update
      updateInfoSection();

      // Watch for badge changes with MutationObserver
      badgeObserver = new MutationObserver(() => {
        updateInfoSection();
      });

      if (anchorBadge) {
        badgeObserver.observe(anchorBadge, {
          childList: true,
          characterData: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['class']
        });
      }

      // Update purchase button availability when amount is selected
      function updatePurchaseButton() {
        const now = Math.floor(Date.now() / 1000);
        const timerStillActive = nextBuild && nextBuild > now;
        const totalCost = selectedAmount ? selectedAmount * pricePerPoint : 0;
        const canAfford = totalCost <= userCash;

        purchaseBtn.disabled = !selectedAmount || timerStillActive || !canAfford;
        if (purchaseBtn.disabled) {
          purchaseBtn.classList.add('disabled');
          purchaseBtn.classList.remove('btn-enabled');
        } else {
          purchaseBtn.classList.remove('disabled');
          purchaseBtn.classList.add('btn-enabled');
        }
      }

      // Initialize purchase button as disabled (no selection yet)
      updatePurchaseButton();

      // Disable radio buttons if timer is active
      if (timerActive) {
        buy1Radio.disabled = true;
        buy10Radio.disabled = true;
      }

      function updateAmountSelection() {
        if (buy1Radio.checked) {
          selectedAmount = 1;
        } else if (buy10Radio.checked) {
          selectedAmount = 10;
        } else {
          selectedAmount = null;
        }

        if (selectedAmount) {
          const totalCost = selectedAmount * pricePerPoint;
          const totalBuildTime = buildDuration * selectedAmount;

          // Update build time display
          const buildTimeDiv = document.getElementById('anchorBuildTime');
          if (buildTimeDiv) {
            buildTimeDiv.textContent = formatBuildTime(totalBuildTime);
          }

          // Update total cost and check affordability
          if (totalCost > userCash) {
            totalCostDiv.classList.add('text-danger');
            totalCostDiv.classList.remove('text-success');
          } else {
            totalCostDiv.classList.add('text-success');
            totalCostDiv.classList.remove('text-danger');
          }
          totalCostDiv.textContent = `$${totalCost.toLocaleString()}`;
        }

        // Update purchase button state
        updatePurchaseButton();
      }

      // Radio button change handlers
      buy1Radio.addEventListener('change', updateAmountSelection);
      buy10Radio.addEventListener('change', updateAmountSelection);

      // Countdown timer update function
      if (timerActive) {
        const timerDisplay = document.getElementById('anchorTimerDisplay');
        const timerOverlay = document.getElementById('anchorTimerOverlay');

        function updateTimer() {
          const now = Math.floor(Date.now() / 1000);
          const remaining = nextBuild - now;

          if (remaining <= 0) {
            // Timer expired - remove overlay, enable buttons
            clearInterval(timerInterval);
            moduleTimerInterval = null;

            // Remove overlay with fade out
            if (timerOverlay) {
              timerOverlay.classList.add('fade-out');
              setTimeout(() => {
                timerOverlay.remove();
              }, 500);
            }

            // Enable buy buttons
            buy1Btn.disabled = false;
            buy1Btn.classList.remove('disabled');
            buy1Btn.classList.add('btn-enabled');
            buy10Btn.disabled = false;
            buy10Btn.classList.remove('disabled');
            buy10Btn.classList.add('btn-enabled');
          } else {
            // Format time remaining
            const totalHours = Math.floor(remaining / 3600);
            const minutes = Math.floor((remaining % 3600) / 60);
            const seconds = remaining % 60;

            // If more than 24 hours, show as days
            if (totalHours >= 24) {
              const days = Math.floor(totalHours / 24);
              const hours = totalHours % 24;
              timerDisplay.textContent = `${days}d ${hours}h ${minutes}m`;
            } else {
              // Format as HH:MM:SS
              timerDisplay.textContent = `${String(totalHours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
            }
          }
        }

        updateTimer();  // Initial update
        timerInterval = setInterval(updateTimer, 1000);  // Update every second
        moduleTimerInterval = timerInterval;  // Update module variable
      }

      // Cancel button
      cancelBtn.addEventListener('click', () => {
        if (timerInterval) {
          clearInterval(timerInterval);
          moduleTimerInterval = null;
        }
        if (badgeObserver) {
          badgeObserver.disconnect();
        }
        overlay.classList.add('hidden');
      });

      // Purchase button click handler
      purchaseBtn.addEventListener('click', async () => {
        if (!selectedAmount || selectedAmount < 1 || (selectedAmount !== 1 && selectedAmount !== 10)) {
          showSideNotification('Please select 1 or 10 anchor points', 'error');
          return;
        }

        const amount = selectedAmount;
        purchaseBtn.disabled = true;
        purchaseBtn.textContent = 'Purchasing...';

        try {
          // Step 1: Purchase anchor points
          const purchaseResponse = await fetch('/api/anchor/purchase', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount })
          });

          const purchaseData = await purchaseResponse.json();

          if (!purchaseData.success) {
            throw new Error(purchaseData.error || 'Purchase failed');
          }

          // Step 2: Reset timing (instant completion exploit) - DISABLED
          // TODO: Re-enable when implementing internal coin system for instant completions
          /*
          try {
            const resetResponse = await fetch('/api/anchor/reset-timing', {
              method: 'POST'
            });

            const resetData = await resetResponse.json();

            if (!resetData.success) {
              console.warn('[Anchor] Reset timing failed, but purchase was successful');
            }
          } catch (resetError) {
            console.warn('[Anchor] Reset timing API call failed:', resetError);
            // Continue anyway - purchase was successful
          }
          */

          // Step 3: Close overlay and show success
          overlay.classList.add('hidden');
          showSideNotification(`⚓ Successfully purchased ${amount} anchor point${amount === 1 ? '' : 's'}!`, 'success');

          // Step 4: Update header displays
          // Update anchor slots (Total X Free Y)
          if (window.updateVesselCount) {
            await window.updateVesselCount();
          }
          // Update cash display (spent money)
          if (window.debouncedUpdateBunkerStatus) {
            window.debouncedUpdateBunkerStatus(500);
          }

        } catch (error) {
          console.error('Anchor purchase failed:', error);
          showSideNotification(`⚓ ${error.message || 'Purchase failed'}`, 'error');
          purchaseBtn.disabled = false;
          purchaseBtn.textContent = 'Purchase';
        }
      });

  } catch (error) {
    console.error('Failed to load anchor price:', error);
    feed.innerHTML = `
      <div style="text-align: center; color: #ef4444; padding: 40px;">
        Failed to load price: ${error.message}
      </div>
    `;
  }

  // Close button handler
  closeBtn.onclick = () => {
    if (timerInterval) {
      clearInterval(timerInterval);
      moduleTimerInterval = null;
    }
    if (badgeObserver) {
      badgeObserver.disconnect();
    }
    overlay.classList.add('hidden');
  };
}

/**
 * Triggers anchor purchase timer overlay across all tabs.
 * Called by WebSocket handler when 'anchor_purchase_timer' is received.
 * @param {number} anchorNextBuild - Unix timestamp when anchor timer completes
 * @global
 */
export function showAnchorTimer(anchorNextBuild, pendingAmount = 1) {
  if (!anchorNextBuild) {
    console.warn('[Anchor Timer] No timestamp provided');
    return;
  }

  // Update module variables
  moduleNextBuild = anchorNextBuild;
  modulePendingAmount = pendingAmount;

  console.log('[Anchor Timer] Timer broadcast received, timestamp:', anchorNextBuild, 'amount:', pendingAmount);

  // If dialog is currently open, trigger a refresh to show the timer
  const overlay = document.getElementById('anchorPurchaseOverlay');
  if (overlay && !overlay.classList.contains('hidden')) {
    console.log('[Anchor Timer] Dialog is open, refreshing to show timer');
    showAnchorPurchaseDialog();  // Refresh the dialog to show timer
  }
}
