/*****
 License
 --------------
 Copyright © 2017 Bill & Melinda Gates Foundation
 The Mojaloop files are made available by the Bill & Melinda Gates Foundation under the Apache License, Version 2.0 (the "License") and you may not use these files except in compliance with the License. You may obtain a copy of the License at
 http://www.apache.org/licenses/LICENSE-2.0
 Unless required by applicable law or agreed to in writing, the Mojaloop files are distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 Contributors
 --------------
 This is the official list of the Mojaloop project contributors for this file.
 Names of the original copyright holders (individuals or organizations)
 should be listed with a '*' in the first column. People who have
 contributed from an organization can be listed under the organization
 that actually holds the copyright for their contributions (see the
 Gates Foundation organization for an example). Those individuals should have
 their names indented and be marked with a '-'. Email address can be added
 optionally within square brackets <email>.
 * Gates Foundation

 * ModusBox
 * Georgi Logodazhki <georgi.logodazhki@modusbox.com>
 * Vijaya Kumar Guthi <vijaya.guthi@modusbox.com> (Original Author)
 --------------
 ******/

const _ = require('lodash')
const customLogger = require('../requestLogger')
const axios = require('axios').default
const https = require('https')
const Config = require('../config')
const MyEventEmitter = require('../MyEventEmitter')
const notificationEmitter = require('../notificationEmitter.js')
const { readFileAsync } = require('../utils')
const expect = require('chai').expect // eslint-disable-line
const JwsSigning = require('../jws/JwsSigning')
const traceHeaderUtils = require('../traceHeaderUtils')
const ConnectionProvider = require('../configuration-providers/mb-connection-manager')
require('request-to-curl')
require('atob') // eslint-disable-line
delete axios.defaults.headers.common.Accept
const context = require('./context')
const openApiDefinitionsModel = require('../mocking/openApiDefinitionsModel')
const uuid = require('uuid')
const utilsInternal = require('../utilsInternal')
const dbAdapter = require('../db/adapters/dbAdapter')
const objectStore = require('../objectStore')
const UniqueIdGenerator = require('../../lib/uniqueIdGenerator')

var terminateTraceIds = {}

const getTracing = (traceID, dfspId) => {
  const tracing = {
    outboundID: traceID,
    sessionID: null
  }
  if (traceID && traceHeaderUtils.isCustomTraceID(traceID)) {
    tracing.outboundID = traceHeaderUtils.getEndToEndID(traceID)
    tracing.sessionID = traceHeaderUtils.getSessionID(traceID)
  }
  if (Config.getSystemConfig().HOSTING_ENABLED) {
    tracing.sessionID = dfspId
  }
  return tracing
}

const OutboundSend = async (inputTemplate, traceID, dfspId) => {
  const startedTimeStamp = new Date()
  const tracing = getTracing(traceID, dfspId)

  const environmentVariables = {
    items: Object.entries(inputTemplate.inputValues || {}).map((item) => { return { type: 'any', key: item[0], value: item[1] } })
  }
  try {
    for (const i in inputTemplate.test_cases) {
      await processTestCase(inputTemplate.test_cases[i], traceID, inputTemplate.inputValues, environmentVariables, dfspId)
    }

    const completedTimeStamp = new Date()
    const runDurationMs = completedTimeStamp.getTime() - startedTimeStamp.getTime()
    // Send the total result to client
    if (tracing.outboundID) {
      const runtimeInformation = {
        completedTimeISO: completedTimeStamp.toISOString(),
        startedTime: startedTimeStamp.toUTCString(),
        completedTime: completedTimeStamp.toUTCString(),
        runDurationMs: runDurationMs,
        avgResponseTime: 'NA',
        totalAssertions: 0,
        totalPassedAssertions: 0
      }
      const totalResult = generateFinalReport(inputTemplate, runtimeInformation)
      if (Config.getSystemConfig().HOSTING_ENABLED) {
        const totalResultCopy = JSON.parse(JSON.stringify(totalResult))
        totalResultCopy.runtimeInformation.completedTimeISO = completedTimeStamp
        dbAdapter.upsert('reports', totalResultCopy, { dfspId })
      }
      notificationEmitter.broadcastOutboundProgress({
        status: 'FINISHED',
        outboundID: tracing.outboundID,
        totalResult
      }, tracing.sessionID)
    }
  } catch (err) {
    notificationEmitter.broadcastOutboundProgress({
      status: 'TERMINATED',
      outboundID: tracing.outboundID
    }, tracing.sessionID)
  }
}

const terminateOutbound = (traceID) => {
  terminateTraceIds[traceID] = true
}

const processTestCase = async (testCase, traceID, inputValues, environmentVariables, dfspId) => {
  const tracing = getTracing(traceID)

  // Load the requests array into an object by the request id to access a particular object faster
  const requestsObj = {}
  // Store the request ids into a new array
  const templateIDArr = []
  for (const i in testCase.requests) {
    requestsObj[testCase.requests[i].id] = testCase.requests[i]
    templateIDArr.push(testCase.requests[i].id)
  }
  // Sort the request ids array
  templateIDArr.sort((a, b) => {
    return a > b
  })

  const apiDefinitions = await openApiDefinitionsModel.getApiDefinitions()
  // Iterate the request ID array
  for (const i in templateIDArr) {
    if (terminateTraceIds[traceID]) {
      delete terminateTraceIds[traceID]
      throw new Error('Terminated')
    }
    const request = requestsObj[templateIDArr[i]]

    const reqApiDefinition = apiDefinitions.find((item) => {
      return (
        item.majorVersion === +request.apiVersion.majorVersion &&
        item.minorVersion === +request.apiVersion.minorVersion &&
        item.type === request.apiVersion.type
      )
    })

    let convertedRequest = JSON.parse(JSON.stringify(request))

    // Form the actual http request headers, body, path and method by replacing configurable parameters
    // Replace the parameters
    convertedRequest = replaceVariables(request, inputValues, request, requestsObj)
    convertedRequest = replaceRequestVariables(convertedRequest)

    // Form the path from params and operationPath
    convertedRequest.path = replacePathVariables(request.operationPath, convertedRequest.params)

    // Insert traceparent header if sessionID passed
    if (tracing.sessionID) {
      convertedRequest.headers = convertedRequest.headers || {}
      convertedRequest.headers.traceparent = '00-' + traceID + '-0123456789abcdef0-00'
    }

    const scriptsExecution = {}
    const environment = {
      data: {}
    }
    const contextObj = await context.generageContextObj(environmentVariables.items)
    // Send http request
    try {
      await executePreRequestScript(convertedRequest, scriptsExecution, contextObj, environmentVariables)

      environment.data = environmentVariables.items.reduce((envObj, item) => { envObj[item.key] = item.value; return envObj }, {})

      convertedRequest = replaceEnvironmentVariables(convertedRequest, environment.data)

      let successCallbackUrl = null
      let errorCallbackUrl = null
      if (request.apiVersion.asynchronous === true) {
        const cbMapRawdata = await readFileAsync(reqApiDefinition.callbackMapFile)
        const reqCallbackMap = JSON.parse(cbMapRawdata)
        if (reqCallbackMap[request.operationPath] && reqCallbackMap[request.operationPath][request.method]) {
          const successCallback = reqCallbackMap[request.operationPath][request.method].successCallback
          const errorCallback = reqCallbackMap[request.operationPath][request.method].errorCallback
          successCallbackUrl = successCallback.method + ' ' + replaceVariables(successCallback.pathPattern, null, convertedRequest)
          errorCallbackUrl = errorCallback.method + ' ' + replaceVariables(errorCallback.pathPattern, null, convertedRequest)
        }
      }

      if (request.delay) {
        await new Promise(resolve => setTimeout(resolve, request.delay))
      }
      const resp = await sendRequest(convertedRequest.url, convertedRequest.method, convertedRequest.path, convertedRequest.queryParams, convertedRequest.headers, convertedRequest.body, successCallbackUrl, errorCallbackUrl, convertedRequest.ignoreCallbacks, dfspId)

      await setResponse(convertedRequest, resp, environment, environmentVariables, request, 'SUCCESS', tracing, testCase, scriptsExecution, contextObj)
    } catch (err) {
      let resp
      try {
        resp = JSON.parse(err.message)
      } catch (parsingErr) {
        resp = err.message
      }
      await setResponse(convertedRequest, resp, environment, environmentVariables, request, 'ERROR', tracing, testCase, scriptsExecution, contextObj)
    } finally {
      contextObj.ctx.dispose()
      contextObj.ctx = null
    }
  }

  // Return status report of this test case
  return testCase
  // Set a timeout if the response callback is not received in a particular time
}

const setResponse = async (convertedRequest, resp, environment, environmentVariables, request, status, tracing, testCase, scriptsExecution, contextObj) => {
  // Get the requestsHistory and callbacksHistory from the objectStore
  const requestsHistoryObj = objectStore.get('requestsHistory')
  const callbacksHistoryObj = objectStore.get('callbacksHistory')
  const backgroundData = {
    requestsHistory: requestsHistoryObj,
    callbacksHistory: callbacksHistoryObj
  }

  await executePostRequestScript(convertedRequest, resp, scriptsExecution, contextObj, environmentVariables, backgroundData)
  environment.data = environmentVariables.items.reduce((envObj, item) => { envObj[item.key] = item.value; return envObj }, {})
  const testResult = await handleTests(convertedRequest, resp.syncResponse, resp.callback, environment.data, backgroundData)
  request.appended = {
    status: status,
    testResult,
    response: resp.syncResponse,
    callback: resp.callback,
    request: convertedRequest,
    additionalInfo: {
      curlRequest: resp.curlRequest
    }
  }
  if (tracing.outboundID) {
    notificationEmitter.broadcastOutboundProgress({
      outboundID: tracing.outboundID,
      testCaseId: testCase.id,
      status: status,
      requestId: request.id,
      response: resp.syncResponse,
      callback: resp.callback,
      requestSent: convertedRequest,
      additionalInfo: {
        curlRequest: resp.curlRequest,
        scriptsExecution: scriptsExecution
      },
      testResult
    }, tracing.sessionID)
  }
}

const executePreRequestScript = async (convertedRequest, scriptsExecution, contextObj, environmentVariables) => {
  if (convertedRequest.scripts && convertedRequest.scripts.preRequest && convertedRequest.scripts.preRequest.exec.length > 0 && convertedRequest.scripts.preRequest.exec !== ['']) {
    scriptsExecution.preRequest = await context.executeAsync(convertedRequest.scripts.preRequest.exec, { context: { ...contextObj, request: convertedRequest }, id: uuid.v4() }, contextObj)
    environmentVariables.items = scriptsExecution.preRequest.environment
  }
}

const executePostRequestScript = async (convertedRequest, resp, scriptsExecution, contextObj, environmentVariables, backgroundData) => {
  if (convertedRequest.scripts && convertedRequest.scripts.postRequest && convertedRequest.scripts.postRequest.exec.length > 0 && convertedRequest.scripts.postRequest.exec !== ['']) {
    let response
    if (_.isString(resp)) {
      response = resp
    } else if (resp.syncResponse) {
      response = { code: resp.syncResponse.status, status: resp.syncResponse.statusText, body: resp.syncResponse.body || resp.syncResponse.data }
    }

    // Pass the requestsHistory and callbacksHistory to postman sandbox
    const collectionVariables = []
    collectionVariables.push(
      {
        type: 'any',
        key: 'requestsHistory',
        value: JSON.stringify(backgroundData.requestsHistory)
      },
      {
        type: 'any',
        key: 'callbacksHistory',
        value: JSON.stringify(backgroundData.callbacksHistory)
      }
    )

    scriptsExecution.postRequest = await context.executeAsync(convertedRequest.scripts.postRequest.exec, { context: { ...contextObj, response, collectionVariables }, id: uuid.v4() }, contextObj)
    environmentVariables.items = scriptsExecution.postRequest.environment
  }
}

const handleTests = async (request, response = null, callback = null, environment = {}, backgroundData = {}) => {
  try {
    const results = {}
    let passedCount = 0
    if (request.tests && request.tests.assertions.length > 0) {
      for (const k in request.tests.assertions) {
        const testCase = request.tests.assertions[k]
        try {
          eval(testCase.exec.join('\n')) // eslint-disable-line
          results[testCase.id] = {
            status: 'SUCCESS'
          }
          passedCount++
        } catch (err) {
          results[testCase.id] = {
            status: 'FAILED',
            message: err.message
          }
        }
      }
    }
    return { results, passedCount }
  } catch (err) {
    return null
  }
}

const getUrlPrefix = (baseUrl) => {
  let returnUrl = baseUrl
  if (!returnUrl.startsWith('http:') && !returnUrl.startsWith('https:')) {
    returnUrl = 'http://' + returnUrl
  }
  if (returnUrl.endsWith('/')) {
    returnUrl = returnUrl.slice(0, returnUrl.length - 1)
  }
  return returnUrl
}

const sendRequest = (baseUrl, method, path, queryParams, headers, body, successCallbackUrl, errorCallbackUrl, ignoreCallbacks, dfspId) => {
  return new Promise((resolve, reject) => {
    (async () => {
      const httpsProps = {}
      const user = dfspId ? { dfspId } : undefined
      const userConfig = await Config.getUserConfig(user)
      const uniqueId = UniqueIdGenerator.generateUniqueId()
      let urlGenerated = userConfig.CALLBACK_ENDPOINT + path
      if (Config.getSystemConfig().HOSTING_ENABLED) {
        const endpointsConfig = await ConnectionProvider.getEndpointsConfig()
        if (endpointsConfig.dfspEndpoints && dfspId && endpointsConfig.dfspEndpoints[dfspId]) {
          urlGenerated = endpointsConfig.dfspEndpoints[dfspId] + path
        } else {
          customLogger.logMessage('warning', 'Hosting is enabled, But there is no endpoint configuration found for DFSP ID: ' + dfspId, { user })
        }
      }
      if (baseUrl) {
        urlGenerated = getUrlPrefix(baseUrl) + path
      }
      if (userConfig.OUTBOUND_MUTUAL_TLS_ENABLED) {
        const tlsConfig = await ConnectionProvider.getTlsConfig()
        if (!tlsConfig.dfsps[dfspId]) {
          const errorMsg = 'Outbound TLS is enabled, but there is no TLS config found for DFSP ID: ' + dfspId
          customLogger.logMessage('error', errorMsg, { user })
          reject(new Error(JSON.stringify({ errorCode: 4000, errorDescription: errorMsg })))
        }
        httpsProps.httpsAgent = new https.Agent({
          cert: tlsConfig.dfsps[dfspId].hubClientCert,
          key: tlsConfig.hubClientKey,
          ca: [tlsConfig.dfsps[dfspId].dfspServerCaRootCert],
          rejectUnauthorized: true
        })
        urlGenerated = urlGenerated.replace('http:', 'https:')
      } else {
        if (urlGenerated.startsWith('https:')) {
          httpsProps.httpsAgent = new https.Agent({
            rejectUnauthorized: false
          })
        }
      }

      const reqOpts = {
        method: method,
        url: urlGenerated,
        path: path,
        params: queryParams,
        headers: headers,
        data: body,
        timeout: 3000,
        validateStatus: function (status) {
          return status < 900 // Reject only if the status code is greater than or equal to 900
        },
        ...httpsProps
      }
      try {
        await JwsSigning.sign(reqOpts)
        customLogger.logOutboundRequest('info', 'JWS signed', { uniqueId, request: reqOpts })
      } catch (err) {
        customLogger.logMessage('error', err.message, { additionalData: err })
      }

      var syncResponse = {}
      var curlRequest = ''
      var timer = null
      if (successCallbackUrl && errorCallbackUrl && (ignoreCallbacks !== true)) {
        timer = setTimeout(() => {
          MyEventEmitter.getEmitter('testOutbound', user).removeAllListeners(successCallbackUrl)
          MyEventEmitter.getEmitter('testOutbound', user).removeAllListeners(errorCallbackUrl)
          reject(new Error(JSON.stringify({ curlRequest: curlRequest, syncResponse: syncResponse, errorCode: 4001, errorMessage: 'Timeout for receiving callback' })))
        }, userConfig.CALLBACK_TIMEOUT)
        // Listen for success callback
        MyEventEmitter.getEmitter('testOutbound', user).once(successCallbackUrl, (callbackHeaders, callbackBody) => {
          clearTimeout(timer)
          MyEventEmitter.getEmitter('testOutbound', user).removeAllListeners(errorCallbackUrl)
          customLogger.logMessage('info', 'Received success callback ' + successCallbackUrl, { request: { headers: callbackHeaders, body: callbackBody }, notification: false })
          resolve({ curlRequest: curlRequest, syncResponse: syncResponse, callback: { url: successCallbackUrl, headers: callbackHeaders, body: callbackBody } })
        })
        // Listen for error callback
        MyEventEmitter.getEmitter('testOutbound', user).once(errorCallbackUrl, (callbackHeaders, callbackBody) => {
          clearTimeout(timer)
          MyEventEmitter.getEmitter('testOutbound', user).removeAllListeners(successCallbackUrl)
          customLogger.logMessage('info', 'Received error callback ' + errorCallbackUrl, { request: { headers: callbackHeaders, body: callbackBody }, notification: false })
          reject(new Error(JSON.stringify({ curlRequest: curlRequest, syncResponse: syncResponse, callback: { url: errorCallbackUrl, headers: callbackHeaders, body: callbackBody } })))
        })
      }

      customLogger.logOutboundRequest('info', 'Sending request ' + reqOpts.method + ' ' + reqOpts.url, { additionalData: { request: reqOpts }, user, uniqueId, request: reqOpts })

      axios(reqOpts).then((result) => {
        syncResponse = {
          status: result.status,
          statusText: result.statusText,
          body: result.data,
          headers: result.headers
        }
        curlRequest = result.request ? result.request.toCurl() : ''

        if (result.status > 299) {
          customLogger.logOutboundRequest('error', 'Received response ' + result.status + ' ' + result.statusText, { additionalData: { response: result }, user, uniqueId, request: reqOpts })
          if (timer) {
            clearTimeout(timer)
            MyEventEmitter.getEmitter('testOutbound', user).removeAllListeners(successCallbackUrl)
            MyEventEmitter.getEmitter('testOutbound', user).removeAllListeners(errorCallbackUrl)
          }
          reject(new Error(JSON.stringify({ curlRequest: curlRequest, syncResponse })))
        } else {
          customLogger.logOutboundRequest('info', 'Received response ' + result.status + ' ' + result.statusText, { additionalData: { response: result }, user, uniqueId, request: reqOpts })
        }

        if (!successCallbackUrl || !errorCallbackUrl || ignoreCallbacks) {
          resolve({ curlRequest: curlRequest, syncResponse: syncResponse })
        }
        customLogger.logMessage('info', 'Received response ' + result.status + ' ' + result.statusText, { additionalData: result.data, notification: false, user })
      }, (err) => {
        syncResponse = {
          status: 500,
          statusText: err.message
        }
        customLogger.logOutboundRequest('error', 'Failed to send request ' + method + ' Error: ' + err.message, { additionalData: err, user, uniqueId, request: reqOpts })
        customLogger.logMessage('error', 'Failed to send request ' + method + ' Error: ' + err.message, { additionalData: err, notification: false, user })
        reject(new Error(JSON.stringify({ errorCode: 4000, syncResponse })))
      })
    })()
  })
}

const setResultObject = (inputObject) => {
  if (typeof inputObject === 'string') {
    return inputObject
  } else if (typeof inputObject === 'object') {
    return JSON.stringify(inputObject)
  }
}

const replaceVariables = (inputObject, inputValues, request, requestsObj) => {
  let resultObject = setResultObject(inputObject)
  if (!resultObject) {
    return inputObject
  }
  // Check the string for any inclusions like {$some_param}
  const matchedArray = resultObject.match(/{\$([^}]+)}/g)
  if (matchedArray) {
    matchedArray.forEach(element => {
      // Check for the function type of param, if its function we need to call a function in custom-functions and replace the returned value
      const splitArr = element.split('.')
      switch (splitArr[0]) {
        case '{$function': {
          resultObject = resultObject.replace(element, getFunctionResult(element, inputValues, request))
          break
        }
        case '{$prev': {
          const temp = element.replace(/{\$prev.(.*)}/, '$1')
          const tempArr = temp.split('.')
          try {
            var replacedValue = _.get(requestsObj[tempArr[0]].appended, temp.replace(tempArr[0] + '.', ''))
            if (replacedValue) {
              resultObject = resultObject.replace(element, replacedValue)
            }
          } catch (err) {
            customLogger.logMessage('error', `${element} not found`, { notification: false })
          }
          break
        }
        case '{$request': {
          const temp = element.replace(/{\$request.(.*)}/, '$1')
          const replacedValue = _.get(request, temp)
          if (replacedValue && !replacedValue.startsWith('{$')) {
            resultObject = resultObject.replace(element, replacedValue)
          }
          break
        }
        case '{$inputs': {
          const temp = element.replace(/{\$inputs.(.*)}/, '$1')
          if (inputValues[temp]) {
            resultObject = resultObject.replace(element, inputValues[temp])
          }
          break
        }
        default:
          break
      }
    })
  }

  return (typeof inputObject === 'object') ? JSON.parse(resultObject) : resultObject
}

const replaceRequestVariables = (inputRequest) => {
  let resultObject = setResultObject(inputRequest)
  if (!resultObject) {
    return inputRequest
  }

  // Check once again for the replaced request variables
  const matchedArray = resultObject.match(/{\$([^}]+)}/g)
  if (matchedArray) {
    matchedArray.forEach(element => {
      // Check for the function type of param, if its function we need to call a function in custom-functions and replace the returned value
      const splitArr = element.split('.')
      switch (splitArr[0]) {
        case '{$request':
          var temp2 = element.replace(/{\$request.(.*)}/, '$1')
          var replacedValue2 = _.get(inputRequest, temp2)
          if (replacedValue2) {
            resultObject = resultObject.replace(element, replacedValue2)
          }
          break
        default:
          break
      }
    })
  }

  return (typeof inputRequest === 'object') ? JSON.parse(resultObject) : resultObject
}

const replaceEnvironmentVariables = (inputRequest, environment) => {
  let resultObject = setResultObject(inputRequest)
  if (!resultObject) {
    return inputRequest
  }

  // Check once again for the replaced request variables
  const matchedArray = resultObject.match(/{\$([^}]+)}/g)
  if (matchedArray) {
    matchedArray.forEach(element => {
      // Check for the function type of param, if its function we need to call a function in custom-functions and replace the returned value
      const splitArr = element.split('.')
      switch (splitArr[0]) {
        case '{$environment':
          var temp2 = element.replace(/{\$environment.(.*)}/, '$1')
          var replacedValue2 = _.get(environment, temp2)
          if (replacedValue2) {
            resultObject = resultObject.replace(element, replacedValue2)
          }
          break
        default:
          break
      }
    })
  }

  return (typeof inputRequest === 'object') ? JSON.parse(resultObject) : resultObject
}

const replacePathVariables = (operationPath, params) => {
  let resultObject = operationPath

  // Check the string for any inclusions like {$some_param}
  const matchedArray = resultObject.match(/{([^}]+)}/g)
  if (matchedArray) {
    matchedArray.forEach(element => {
      var temp = element.replace(/{([^}]+)}/, '$1')
      if (params && params[temp]) {
        resultObject = resultObject.replace(element, params[temp])
      }
    })
  }

  return resultObject
}

// Execute the function and return the result
const getFunctionResult = (param, inputValues, request) => {
  return utilsInternal.getFunctionResult(param, inputValues, request)
}

// Generate consolidated final report
const generateFinalReport = (inputTemplate, runtimeInformation) => {
  const { test_cases, ...remaingPropsInTemplate } = inputTemplate  // eslint-disable-line
  const resultTestCases = test_cases.map(testCase => {
    const { requests, ...remainingPropsInTestCase } = testCase
    const resultRequests = requests.map(requestItem => {
      const { testResult, request, ...remainginPropsInRequest } = requestItem.appended
      if (request.tests && request.tests.assertions) {
        request.tests.assertions = request.tests.assertions.map(assertion => {
          return {
            ...assertion,
            resultStatus: testResult.results[assertion.id]
          }
        })
        request.tests.passedAssertionsCount = testResult.passedCount
        runtimeInformation.totalAssertions += request.tests.assertions.length
        runtimeInformation.totalPassedAssertions += request.tests.passedAssertionsCount
      }
      return {
        request,
        ...remainginPropsInRequest
      }
    })
    return {
      ...remainingPropsInTestCase,
      requests: resultRequests
    }
  })
  return {
    ...remaingPropsInTemplate,
    test_cases: resultTestCases,
    runtimeInformation: runtimeInformation
  }
}

module.exports = {
  OutboundSend,
  terminateOutbound,
  handleTests,
  sendRequest,
  replaceVariables,
  replaceRequestVariables,
  replaceEnvironmentVariables,
  replacePathVariables,
  getFunctionResult,
  generateFinalReport
}
