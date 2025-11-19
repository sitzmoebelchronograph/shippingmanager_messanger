/**
 * @fileoverview Alliance Logo Proxy with Color Replacement
 *
 * Proxies alliance logo SVGs from shippingmanager.cc and replaces
 * the fill color with the specified primary color from image_colors.
 *
 * @module server/routes/alliance-logo
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const logger = require('../utils/logger');

/**
 * Alliance logo proxy with color replacement
 *
 * Fetches SVG from shippingmanager.cc and replaces fill colors.
 *
 * @route GET /api/alliance-logo/:imageName
 * @param {string} imageName - Logo name (e.g., 'alliance_logo_02')
 * @query {string} color - Hex color to use for fill (e.g., '#eff5f7')
 * @returns {SVG} SVG with replaced fill color
 *
 * @example
 * GET /api/alliance-logo/alliance_logo_02?color=%23eff5f7
 * Response: SVG with fill="#eff5f7"
 */
router.get('/:imageName', async (req, res) => {
  const { imageName } = req.params;
  const { color } = req.query;

  if (!imageName) {
    return res.status(400).json({ error: 'Image name required' });
  }

  // Validate image name format
  if (!/^alliance_logo_\d+$/.test(imageName)) {
    return res.status(400).json({ error: 'Invalid image name format' });
  }

  const svgUrl = `https://shippingmanager.cc/images/alliances/${imageName}.svg`;

  try {
    const response = await axios.get(svgUrl, {
      responseType: 'text',
      timeout: 10000
    });

    let svgContent = response.data;

    // Replace fill color if specified
    if (color) {
      // Decode URL-encoded color (e.g., %23eff5f7 -> #eff5f7)
      const decodedColor = decodeURIComponent(color);

      // Replace existing fill attributes in the SVG
      svgContent = svgContent.replace(/fill="[^"]+"/g, `fill="${decodedColor}"`);

      // Add fill attribute to <path> elements that don't have one
      // This handles SVGs that use default black fill
      svgContent = svgContent.replace(/<path(?![^>]*fill=)/g, `<path fill="${decodedColor}" `);
    }

    // Set cache headers (1 hour since colors might change)
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Content-Type', 'image/svg+xml');
    res.send(svgContent);

  } catch (error) {
    logger.error(`[AllianceLogo] Failed to fetch ${imageName}:`, error.message);
    res.status(404).json({ error: 'Logo not found' });
  }
});

module.exports = router;
