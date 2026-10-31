const mongoose = require('mongoose');

/**
 * A number or handle the protected user has vouched for: family, their doctor,
 * their bank's real helpline.
 *
 * A message from a trusted contact never reaches the decoy, whatever it scores.
 * The worst case for a trusted contact is a warning that their account may have
 * been taken over.
 */
const TrustedContactSchema = new mongoose.Schema({
    // Which protected user trusts this contact.
    userId: { type: String, required: true, index: true },

    // Normalised identifier: +91XXXXXXXXXX for a phone, lowercased otherwise.
    identifier: { type: String, required: true },

    // What the user actually typed, kept so the UI can show it back.
    raw: { type: String, default: '' },

    label: { type: String, default: '' },      // "my son", "Dr. Kulkarni"
    relationship: { type: String, default: '' }, // family | doctor | bank | other

    // Set when the contact was added by resolving a false positive, so the
    // provenance of the trust decision is visible later.
    addedFrom: { type: String, default: 'manual' }, // manual | false_positive

    createdAt: { type: Date, default: Date.now },
}, { timestamps: true });

TrustedContactSchema.index({ userId: 1, identifier: 1 }, { unique: true });

module.exports = mongoose.models.TrustedContact
    || mongoose.model('TrustedContact', TrustedContactSchema);
