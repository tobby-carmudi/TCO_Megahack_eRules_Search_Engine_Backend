import request from 'superagent';
import decorate from 'decorate-it';
import Joi from 'joi';
import co from 'co';
import HTTPError from 'http-errors';
import _ from 'lodash';
import config from 'config';
import parser from 'lrs_parser';

// ------------------------------------
// Exports
// ------------------------------------

const RegulationsService = {
  getDetails,
  search,
};

decorate(RegulationsService, 'RegulationsService');

export default RegulationsService;

/**
 * Make request to EPA API
 * @param {Object} req
 * @returns {Object} the response body
 * @private
 */
async function _makeRequest(req) {
  try {
    const { body } = await req.endAsync();
    return body;
  } catch (e) {
    const status = _.get(e, 'response.body.status');
    const message = _.get(e, 'response.body.message');
    if (status && message) {
      throw new HTTPError(status, message);
    }
    throw e;
  }
}

/**
 * Get regulations details
 * @param {String} documentId the document id
 * @param {String} zip the zip code
 * @returns {Object} the details
 */
async function getDetails(documentId, zip, stateAbbr, city, street, program) {
  const details = await _makeRequest(request
    .get(`${config.API_BASE_URL}/document.json`)
    .query({
      api_key: config.API_KEY,
      documentId,
    }));

  let facilities = [];
  let options = {
    output: 'json'
  };

  var showFacility = false;
  if (zip) {
    options['zip_code'] = zip;
    showFacility = true;
  }
  if (city) {
    options['city_name'] = city;
    showFacility = true;
  }
  if (street) {
    options['street_address'] = street;
    showFacility = true;
  }
  if (stateAbbr) {
    options['state_abbr'] = stateAbbr;
  }
  if (program) {
    options['program_name'] = program;
  }

  if (showFacility) {
    facilities = await _makeRequest(request
      .get('http://ofmpub.epa.gov/enviro/frs_rest_services.get_facilities')
      .query(options));
  }

  const documentCfrs = extractCfrs(details.cfrPart.value);
  details.programs = await co(parser.getProgramByCFR(documentCfrs));
  details.allRegulations = await co(parser.getRegulationByCFR(documentCfrs));

  const htmlLink = _.get(details, 'fileFormats[1]');
  if (htmlLink) {
    const { text: htmlContent } = await request.get(htmlLink).query({ api_key: config.API_KEY }).endAsync();

    const summaryRegex = /SUMMARY: ([\s\S]+?)\n\n/;
    const addressRegex = /ADDRESSES :([\s\S]+?)\n\n/;
    const datesRegex = /DATES: ([\s\S]+?)\n\n/;
    const contactInfoRegex = /FOR FURTHER INFORMATION CONTACT: ([\s\S]+?)\n\n/;
    const supInfoRegex = /SUPPLEMENTARY INFORMATION: ([\s\S]+?)\[\[Page/;

    details.summary = _.get(summaryRegex.exec(htmlContent), '[1]');
    details.dates = _.get(datesRegex.exec(htmlContent), '[1]');
    details.addresses = _.get(addressRegex.exec(htmlContent), '[1]');
    details.contact = _.get(contactInfoRegex.exec(htmlContent), '[1]');
    details.supInfo = _.get(supInfoRegex.exec(htmlContent), '[1]');
  }

  details.facilities = facilities.Results.FRSFacility;

  return details;
}

getDetails.params = ['documentId', 'zip', 'stateAbbr', 'city', 'street', 'program'];
getDetails.schema = {
  documentId: Joi.string().required(),
  zip: Joi.string(),
  stateAbbr: Joi.string(),
  city: Joi.string(),
  street: Joi.string(),
  program: Joi.string(),
};


/**
 * Search regulations
 * @param {Object} criteria the search criteria
 * @param {String} criteria.naics
 * @param {String} criteria.zip
 * @param {String} criteria.substance
 * @param {String} criteria.program
 * @param {Number} criteria.offset
 * @param {Number} criteria.limit
 * @returns {{items: Array, total: Number}} the results
 */
async function search(criteria) {
  var search = [criteria.substance, criteria.naics];

  if (criteria.program) {
    const { items: programs } = await co(parser.searchPrograms(criteria.program, 0, 10000));
    const cfrs = _(programs)
      .flatMap('regulations')
      .map((item) => item.toJSON().cfr)
      .compact()
      .value();

    if (cfrs.length == 0) {
      return { items: [], total: 0 };
    }

    _.each(cfrs, (value) => search.push(value));
  }

  let keywords = _(search).compact().join(' ');

  let { totalNumRecords: total, documents: items } = await _makeRequest(request
      .get(`${config.API_BASE_URL}/documents.json`)
      .query({
        api_key: config.API_KEY,
        a: 'EPA',
        // docst: 'Notice+of+Proposed+Rulemaking+(NPRM)',
        dct: 'PR',
        dkt: 'R',
        cp: 'O',
        rpp: criteria.limit,
        po: criteria.offset,
        s: keywords.length == 0 ? null : keywords,
      }));

  if (!items) {
    return { items: [], total: 0 };
  }

  await Promise.map(items, async(item) => {
    const details = await _makeRequest(request
      .get(`${config.API_BASE_URL}/document.json`)
      .query({
        api_key: config.API_KEY,
        documentId: item.documentId,
      }));
    item.cfrPart = details.cfrPart;
  });

  return {
    items,
    total,
  };
}

search.params = ['criteria'];
search.schema = {
  criteria: {
    naics: Joi.string(),
    zip: Joi.string(),
    state: Joi.string(),
    city: Joi.string(),
    street: Joi.string(),
    substance: Joi.string(),
    program: Joi.string(),
    offset: Joi.offset(),
    limit: Joi.limit(),
  },
};

/**
 * Helper method to extract CFRs from a cfrPart value returned by the regulations.gov API.
 *
 * @param {String} cfrString the cfrPart string value obtained from the regulations.gov API
 *
 * @return {Array} a list of the CFRs
 */
function extractCfrs(cfrString) {
  const cfrs = cfrString.substring('40 CFR'.length).match(/\d+/g);
  return cfrs;
}
