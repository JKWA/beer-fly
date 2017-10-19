const functions = require('firebase-functions'),
      admin = require('firebase-admin'),
      GeoFire = require('geofire'),
      gcs = require('@google-cloud/storage')({keyFilename:'serviceAccountKey.json'}),
      vision = require('@google-cloud/vision')(),
      exec = require('child-process-promise').exec,
      spawn = require('child-process-promise').spawn,
      logging = require('@google-cloud/logging')(),
      fs = require('fs'),
      swearjar = require('swearjar');

const stripe = require('stripe')(functions.config().stripe.token),
      currency = functions.config().stripe.currency || 'USD';

admin.initializeApp(functions.config().firebase);

const googleMapsClient = require('@google/maps').createClient({key: functions.config().map.key});

const geoRef = admin.database().ref('GeoFire'),
      geoFire = new GeoFire(geoRef),
      geoCrawlRef = admin.database().ref('GeoCrawl'),
      geoCrawl = new GeoFire(geoCrawlRef)


exports.createNewUser = functions.auth.user().onCreate(function(event) {
   
  const data = event.data;
  const uid = data.uid;

  var obj = {};
  
  if(data.displayName){
    obj.displayName = data.displayName;
  }

  if(data.email){
    obj.email = data.email;
  }

  if(data.emailVerified){
    obj.verified = data.emailVerified;
  }

  if(data.email){
    obj.domain = data.email.split('@')[1];
  }

  obj.initialLogin = Date.now(obj);

  console.log('USER', obj);

  return stripe.customers.create({email: data.email})
    .then(customer => {
      obj.stripe = {stripe_id: customer.id}
 
      return admin.database().ref('/user').child(uid)
        .update(obj)
        .then(function (){
          console.log('SAVED_INITIAL_USER');
        })
        .catch( function (error){
          console.log('SAVE_ERROR', error)
          return reportError(error, {user: uid});
        })
    })
  });


exports.cleanupUser = functions.auth.user()
  .onDelete(event => {
    return admin.database().ref(`/user/${event.data.uid}/stripe/stripe_id`)
      .once('value').then(snapshot => {
        return snapshot.val();
      })
      .then(customer => {
        return stripe.customers.del(customer);
      })
      .then(() => {
        let obj = {};
        obj.deleted = true;
        obj.stripe = null;

        return admin.database().ref(`/user/${event.data.uid}`)
         .update(obj)
         .catch(error =>{
           return reportError(error, {user: event.data.uid});
         })
      });
  });


exports.createNewOrganization = functions.database.ref('/organization/{place_id}')
  .onCreate(event => {

    const data = event.data,
          place_id = event.params.place_id


    // if (!data.exists()) {
    //   console.log('item deleted')
    //   return null;
    // }

    return googleMapsClient.place({placeid: place_id},  function(error, response) { 
      if(!error){
        const place = parseGooglePlaceData(response.json.result, place_id),
              domain = place.domain,
              types = response.json.result.types

        if(!place.place_id){
          return null
        }
        console.log('types', types)
        if(types){
          for(let value of types){
            // console.log(value)
            if(value === 'bar'){
              place['PUB'] = true;
              break;
            }
          }          
        }

        if(place.name){

          if(place.name.toLowerCase().indexOf('brewing')>-1){
            place['BREWERY'] = true
          }

          if(place.name.toLowerCase().indexOf('brewery')>-1){
            place['BREWERY'] = true
          }

          if(place.name.toLowerCase().indexOf('truck')>-1){
            place['TRUCK'] = true
          }
        }


        if(domain){
          admin.database().ref(`/organization`).orderByChild(`domain`).equalTo(domain).limitToFirst(1)
          .once('value')
          .then(snapshot =>{
            if(snapshot.exists()){
               snapshot.forEach(child => {
                  var locationItems = ['breweryName', 'description', 'motto', 'mainImage', 'beerLastUpdated']
                  for(let locationKey of locationItems)

                    if(child[locationKey]){
                      place[locationKey] = child[locationKey];
                    }

                    if(child.brewBeer){
                      place['brewBeer'] = child.brewBeer;
                      place['category/BEER/display'] = true
                      place['category/BEER/name'] = 'beer'
                      place['category/BEER/label'] = 'Beer'
                      place['category/BEER/order'] = 200
                    }

               })
            }
          })
        }

        admin.database().ref(`/organization/${place_id}`)
          .update(place)
          .then(() =>{
            console.log('PLACE_SAVED', place)
            
          })
          .catch(error => {
            console.error(error)
          })
        
        
      }else{
        console.error(error)
      }
    })
  })


exports.updateDomainData = functions.database.ref('/newOrg/{place_id}/{domain}')
  .onWrite(event => {

    const data = event.data,
          place_id = event.params.place_id,
          domain = event.params.domain

    if (!data.exists()) {
      console.log('item deleted')
      return null;
    }

    return googleMapsClient.place({placeid: place_id},  function(error, response) { 
      if(!error){
        const place = parseGooglePlaceData(response.json.result, place_id)
        if(place.place_id){
          admin.database().ref(`/organization/${place_id}`)
          .update(place)
          .then(() =>{
            console.log('PLACE_SAVED', place)
            admin.database().ref(`/newOrg/${place_id}`).update({domain:(place.domain)?place.domain:null})
            .then(() =>{
              console.log('domain saved back to google')
            })
            .catch(error =>{
              console.log('ERROR', error)
            })
          })
          .catch(error => {
            console.error(error)
          })
        }
        
      }else{
        console.error(error)
      }
    })
  })



exports.createStripeCharge = functions.database.ref('/user/{user_id}/stripe/organization/{place_id}/charges/{charge_id}')
  .onWrite(event => {
    const val = event.data.val(),
          metadata = event.params,
          charge_id = metadata.charge_id,
          place_id = metadata.place_id,
          user_id = metadata.user_id

    //precheck
    if(val === null){
      console.log('Deletion event', metadata)
      return null
    }
    if(val.status === 'canceled'){
      console.log('Charge previously canceled', metadata)
      return null;
    }
    if(val.id){
      console.log('Stripe charge exists', metadata)
      if(val.delete){
        return stripe.subscriptions.del(val.id)
          .then(deleteResult =>{
            console.log('Cancel charge', metadata)
            return event.data.adminRef.update(deleteResult)
          .then(()=>{
            const cancelObj = {
              cancel_at_period_end: deleteResult.cancel_at_period_end,
              id:null,
              interval:null,
              interval_count:null,
              user_id:null,
              status: deleteResult.status,
              charge_id: null
            }
            return admin.database().ref(`/organization/${place_id}/plan`).update(cancelObj)
            })
          })

      }else{
        return null
      }
    }
    if(val.error){
      console.log('Previous stripe error for this charge', metadata)
      return null
    }
    
    // if pass prechecks
    // Look up the Stripe customer id
    return admin.database().ref(`/user/${user_id}/stripe/stripe_id`)
      .once('value').then(snapshot => {
        const customer_id = snapshot.val()
          return customer_id;
      })
      .then(customer => {
        //submit stripe subscription
        const source = val.token,
              plan = val.plan
              
        return stripe.subscriptions
          .create({
              customer: customer,
              source: source,
              plan: plan,
              metadata: {place_id: place_id,
                        charge_id: charge_id,
                        user_id: user_id}
            }, {
              idempotency_key: charge_id
          })
          .catch(error =>{
            
            console.log('error', error)
            var errorObj = {
              type: error.type,
              message: error.message,
              code: error.code,
              created: Math.round(Date.now()/1000)
            }
            return event.data.adminRef.child('error')
              .update(errorObj)
              // .then(()=>{
              //   return reportError(error, metadata)
              // })
            
          })
      })
      .then(response => {
        //write subscription data back to database
        if(!response){
          return null;
        }
        console.log('response', response)
        return event.data.adminRef.update(response)
      .then(() => {
          
          //get org data
        return admin.database().ref(`organization/${place_id}`).once('value')
      })
      .then(orgSnap =>{
          const organization = orgSnap.val()
          console.log('orgdata', organization)
    
          //get basic data
          const orgData = {
            name: organization.name,
            formatted_address: organization.formatted_address,
            place_id: organization.place_id
          }
          //save basic data to charge 
          return admin.database().ref(`/user/${user_id}/stripe/organization/${place_id}`)
          .update(orgData)
      })
      .then(() => {
        //create obj of basic subscription information
        const orgPlan = {
          current_period_end: response.current_period_end,
          user_id: user_id,
          id: response.id,
          interval: response.plan.interval,
          interval_count: response.plan.interval_count,
          name: response.plan.id,
          label: response.plan.name,
          cancel_at_period_end: response.cancel_at_period_end,
          status: response.status,
          charge_id: charge_id
        };
        //save to organization
        return admin.database().ref(`/organization/${place_id}/plan`)
        .set(orgPlan)
      })
        
      .catch(error => {
        //catch errors
        return event.data.adminRef.child('error').set(userFacingMessage(error))
          .then(() => {
            return reportError(error, metadata)
        })
      })
    })
  })



    // return getGooglePlaceData(place_id)
    //   .then(place =>{
    //   console.log('place promise', place)
    // }) 
    // var placeData = getGooglePlaceData(place_id)

  

    // return 
          // if(pubDomain){
          //   admin.database().ref(`organization/${place_id}/place_id`)
          //   .once('value')
          //   .then(snapshot =>{
          //     if(snapshot.exists()){
          //        admin.database().ref('organization')
          //         .orderByChild('domain').equalTo(pubDomain).limitToFirst(1)  
          //           .once("value")
          //           .then(snapshot =>{
          //             if (snapshot.exists()){
          //               snapshot.forEach(child =>{

          //               var locationItems = ['breweryName', 'description', 'motto', 'mainImage', 'beerLastUpdated']
          //               for(let locationKey of locationItems)

          //               if(child[locationKey]){
          //                 newPub[preOrg+locationKey] = child[locationKey];
          //               }

          //               if(child.brewBeer){
          //                 newPub[preOrg+'brewBeer'] = child.brewBeer;
          //                 newPub[preOrg+'category/BEER/display'] = true;
          //               }
                        
          //               })       
          //             }
          //           })
          //       }

          //     })
          // }
      // console.log('newPub2', placeData);
      // return admin.database().ref('/organization')
      //   .update(placeData)
      //   .catch( error =>{
      //     console.error(error)
      //   })

       
    // })   
            
  // });





exports.updateTapGeoData = functions.database.ref('organization/{placeId}/onTap/{beerId}')
  .onWrite(event => {
    const snapshot = event.data;
    const placeId = event.params.placeId;
    const beerId = event.params.beerId;
    const data = snapshot.val();

    console.log('beerId', beerId);
    console.log('placeId', placeId);
    console.log('tap-data', data);

    if(event.data.previous.exists()){
      if(!event.data.exists()){
        console.log('tap data deleted');
        return removeGeoData(placeId, beerId);
      }else{
        console.log('tap data changed', data.tapped);
        if(data.tapped === 'TAPPED'){
          return setGeoData(data, placeId, beerId);
        }else{
          return removeGeoData(placeId, beerId);
        }
      }
    }
    console.log('tap data added');
 
    return setGeoData(data, placeId, beerId);

  })

exports.newBeerAdded = functions.database.ref('organization/{place_id}/brewBeer/{beer_id}')
  .onCreate(event => {

    const snapshot = event.data,
          root = snapshot.ref.root,
          place_id = event.params.place_id,
          beer_id = event.params.beer_id,
          user_id = event.auth.variable.user_id,
          userData = admin.database().ref(`user/${user_id}`).once('value'),
          data = snapshot.val(),
          name = data.name,
          saveObj = {},
          orgData = root.child(`organization/${place_id}`).once('value'),
          beerDB = admin.database().ref(`beer/${beer_id}`),
          setLocation = admin.database().ref(`beer/${beer_id}/location/${place_id}`).set(true),
          setBeerId = admin.database().ref(`organization/${place_id}/brewBeer/${beer_id}/id`).set(beer_id),
          orgItems = ['city', 'domain', 'latitude', 'location',
                      'longitude', 'state', 'stateAbbreviation','place_id']

      console.log('triggered beer added')
      
      return Promise.all([orgData, userData, setLocation, setBeerId])

        .then(results =>{
          const orgResults = results[0].val(),
                userResults = results[1].val(),
                owner = (userResults.ADMIN || userResults.domain === orgResults.domain) ? true : false,
                status = (owner) ? 'verified' : 'not_verified',
                updateStatus = admin.database().ref(`organization/${place_id}/brewBeer/${beer_id}/status`).set(status)

          for (let item of orgItems){
            saveObj[item] = (orgResults[item]) ? orgResults[item] : null
          }
          saveObj.status = status

          const updateBeer = beerDB.update(saveObj)

          return Promise.all([updateStatus, updateBeer])

        .then(results => {
          console.log('updated beer data')
        })
        .catch(error =>{
          console.error(error)
        })
      })
                 
  })

exports.beerStyleChanged = functions.database.ref('organization/{place_id}/brewBeer/{beer_id}/styleId')
  .onWrite(event => {
    const snapshot = event.data,
          root = snapshot.ref.root,
          place_id = event.params.place_id,
          beer_id = event.params.beer_id,
          styleId = snapshot.val(),
          saveObj = {},
          orgData = root.child(`organization/${place_id}`).once('value'),
          styleData = root.child(`category/STYLE/${styleId}`).once('value'),
          beerDB = root.child(`beer/${beer_id}`),
          styleDB = admin.database().ref(`organization/${place_id}/brewBeer/${beer_id}`),
          styleItems = ['category', 'categoryName', 'categoryTitle', 'styleName', 'order']


      if(!snapshot.exists()){
        console.log('beer style deleted');
        return 
      }


      return Promise.all([styleData, orgData])

        .then(results =>{
          const styleValue = results[0].val(),
                orgValue = results[1].val()

          for (let item of styleItems){
            saveObj[item] = (styleValue[item]) ? styleValue[item] : null
          }
          
          styleDB.update(Object.assign({}, saveObj))
          return orgValue
        })

        
        .then(orgValue =>{

          saveObj.styleId = styleId

          if(orgValue.stateAbbreviation && saveObj.category){
            saveObj['stateAndCategory'] = `${orgValue.stateAbbreviation}_${saveObj.category}`
          }

          if(orgValue.stateAbbreviation && saveObj.styleId){
            saveObj['stateAndStyleId'] = `${orgValue.stateAbbreviation}_${saveObj.styleId}`
          }

        return beerDB.update(saveObj)
                
        })
        .then(()=>{
          console.log('updated beer data')
        })
        .catch(error =>{
          console.error(error)
        })

  });

exports.beerNameChanged = functions.database.ref('organization/{place_id}/brewBeer/{beer_id}/name')
  .onWrite(event => {
    const snapshot = event.data,
          root = snapshot.ref.root,
          place_id = event.params.place_id,
          beer_id = event.params.beer_id,
          name = (snapshot.exists()) ? snapshot.val() : null

    if(swearjar.profane(name)){
      return snapshot.adminRef.set(swearjar.censor(name))
        .then(() =>{
          console.log('censored name')
        })
    }

    return root.child(`beer/${beer_id}/name`).set(name)
        .then(() => {
          console.log('updated name in beer file')
        })

  });
exports.beerDescriptionChanged = functions.database.ref('organization/{place_id}/brewBeer/{beer_id}/description')
  .onWrite(event => {
    const snapshot = event.data,
          root = snapshot.ref.root,
          place_id = event.params.place_id,
          beer_id = event.params.beer_id,
          description = (snapshot.exists()) ? snapshot.val() : null

    if(swearjar.profane(description)){
      return snapshot.adminRef.set(swearjar.censor(description))
        .then(() =>{
          console.log('censored description')
        })
    }

    return root.child(`beer/${beer_id}/description`).set(description)
        .then(() => {
          console.log('updated description in beer file')
        })

  });

exports.beerABVChanged = functions.database.ref('organization/{place_id}/brewBeer/{beer_id}/abv')
  .onWrite(event => {
    const snapshot = event.data,
          root = snapshot.ref.root,
          place_id = event.params.place_id,
          beer_id = event.params.beer_id,
          abv = (snapshot.exists()) ? snapshot.val() : null

    return root.child(`beer/${beer_id}/abv`).set(abv)
        .then(() => {
          console.log('updated abv in beer file')
        })

  });

exports.beerStatusChanged = functions.database.ref('organization/{place_id}/brewBeer/{beer_id}/status') 
  .onWrite(event => {
    const snapshot = event.data,
          root = snapshot.ref.root,
          place_id = event.params.place_id,
          beer_id = event.params.beer_id,
          status = (snapshot.exists()) ? snapshot.val() : null

    return root.child(`beer/${beer_id}/status`).set(status)
        .then(() => {
          console.log('updated status in beer file')
        })

  });







exports.updateFoodTruckScheduleFromPub = functions.database.ref('/organization/{placeId}/foodTruck/{truckId}/period/{day}')
    .onWrite(event => {
      const snapshot = event.data;
      const placeId = event.params.placeId;
      const truckId = event.params.truckId;
      const day = event.params.day;
      const data = snapshot.val();
     
      // Exit when the data is deleted.
      if (!event.data.exists()) {
        console.log('item deleted')
        admin.database().ref('organization')
          .child(truckId).child('schedule').child(day).child('organization').child(placeId)
          .remove()
          .then(function(){
            console.log('deleted', data)
          })
          .catch(function(error){
            console.log('delete error', error);
          })

        return;
      }
      
      console.log('new or edited truck calendar data', data);
      admin.database().ref('organization').child(placeId).once('value')
        .then(function (pubSnap){
          var pub = pubSnap.val();
          
          
          var pubObj = {};

          var metaItems = ['label', 'day']
          for(var i=0; i<metaItems.length; i++){
            pubObj[day+'/'+metaItems[i]] = data[metaItems[i]]
          }

          var scheduleItems = ['CLOSE', 'OPEN'];
          for(var i=0; i<scheduleItems.length; i++){
            if(data[scheduleItems[i]]){
              pubObj[day+'/organization/'+pub.place_id+'/'+scheduleItems[i]] = data[scheduleItems[i]];
            }
          }

          var pubItems = ['name', 'place_id', 'vicinity', 'latitude', 'longitude'];
           for(var i=0; i<pubItems.length; i++){
            if(pub[pubItems[i]]){
              pubObj[day+'/organization/'+pub.place_id+'/'+pubItems[i]] = pub[pubItems[i]];
            }
          }
         
          admin.database().ref('organization').child(truckId)
            .child('schedule')
            .update(pubObj)
            .then(function(){
              console.log('schedule data updated')
            })
            .catch(function (error){
              console.log('schedule data error', error);
            })
          
        })
        .catch(function (error){
          console.log('error looking up pub meta data')
        })
      

      return;});

exports.updateFoodTruckScheduleToPub = functions.database.ref('/organization/{truckId}/schedule/{day}/organization/{placeId}')
    .onWrite(event => {
      const snapshot = event.data;
      const placeId = event.params.placeId;
      const truckId = event.params.truckId;
      const day = event.params.day;
      const data = snapshot.val();
     
      // Exit when the data is deleted.
      if (!event.data.exists()) {
        console.log('item deleted')
        admin.database().ref('organization')
          .child(placeId).child('foodTruck').child(truckId).child('period').child(day)
          .remove()
          .then(function(){
            console.log('deleted')
          })
          .catch(function(error){
            console.log('delete error', error);
          })

        return;
      }
      
      console.log('new or edited truck calendar data', data);
     
      admin.database().ref('organization').child(truckId).once('value')
        .then(function (truckSnap){
          var truck = truckSnap.val();
          
          var truckObj = {};

          var truckItems = ['name', 'place_id'];
          for(var i=0; i<truckItems.length; i++){
            truckObj[truckItems[i]] = truck[truckItems[i]]
          }

         

          
          var scheduleItems = ['CLOSE', 'OPEN'];
          for(var i=0; i<scheduleItems.length; i++){
            if(data[scheduleItems[i]]){
              truckObj['period/'+day+'/'+scheduleItems[i]] = data[scheduleItems[i]];
            }
          }
          
          return truckObj;
          
        })
        .catch(function (error){
          console.log('error looking up pub meta data')
        })
        .then(function (truckObj){
            admin.database().ref('category').child('DAY').child(day).once('value')
              .then(function(snapshot){
                var dayData = snapshot.val();

                 var metaItems = ['day', 'label']; 

                  for(var i=0; i<metaItems.length; i++){
                    if(dayData[metaItems[i]]){
                      truckObj['period/'+day+'/'+metaItems[i]] = dayData[metaItems[i]];
                    }
                  }
                  console.log('final', truckObj);
                  return truckObj;
              })
              .catch(function (error){
                console.log('ERROR_GET_DAY', error)
              })
              .then(function(truckObj){
                admin.database().ref('organization').child(placeId).child('foodTruck').child(truckId)
                  .update(truckObj)
                  .then(function(){
                    console.log('save schedule data')
                  })
                  .catch(function (error){
                    console.log('ERROR_SAVING_SCHEDULE', error)
                  })
              })
        })
      
      return;});



exports.processImage = functions.storage.object().onChange(event => {
  const object = event.data;
  const bucket = gcs.bucket(object.bucket);
  const file = bucket.file(object.name);
  const fileArray = object.name.split('/');
  const fileName = fileArray.pop();
  const tempLocalFile = `/tmp/${fileName}`;
  const dataPath = fileArray.join('/');
  const fileNameArray = fileName.split('.');
  const fileNamePrefix = fileNameArray[0];
  const fileNameExtention = fileNameArray[1];
  

  console.log(event.data);
  let destination = object.name;
  let destinationName = fileName;
 

  if(object.size > 120000){
    if(fileNameExtention !== 'jpeg'){
      destination = dataPath+fileNamePrefix+'.jpeg'
      destinationName = fileNamePrefix+'.jpeg'
    }
  }


  // Exit if this is a deletion or a deploy event.
  if (object.resourceState === 'not_exists') {
    return console.log('This is a deletion event.');
  } else if (!object.name) {
    return console.log('This is a deploy event.');
  }

  if(!object.contentType.startsWith('image/')){
    //delete if not an image
    console.log('This is not an image');
    return bucket.file(object.name).delete();
  }

  // Check the image content using the Cloud Vision API.
  return vision.detectSafeSearch(file).then(safeSearchResult => {
    if (safeSearchResult[0].adult || safeSearchResult[0].violence) {
      console.log('The image', object.name, 'has been detected as inappropriate.');
      return bucket.file(object.name).delete();
    } 

      console.log('The image', object.name,'has been detected as OK.');

     
       return bucket.getFiles({prefix: dataPath+'/'})
    
      .then(data => {

        for (let file of data[0]) {
          if(object.name != file.name){
            bucket.file(file.name).delete()
          }
        }
      })

      .then(() => {
        console.log('deleted other files');

      if(object.size <= 120000){
        console.log('Size okay');

        return bucket.file(object.name).download({destination: tempLocalFile})
          .then(() => {
            return spawn('convert',[tempLocalFile, '-thumbnail', '100x100', tempLocalFile]);

          }).then(() => {

            console.log('Thumbnail created.');

          
            fs.readFile(tempLocalFile, 'base64', function (err, data) {
              if (err) {
                console.log(err);
                return 
              }else{
                return admin.database().ref(dataPath).update({thumbnail: data});
              }
            });
          
            
          }).then((file) => {
            console.log('Base 64 image has been saved');
            return;
          })
   

      }else{
        console.log('Size too large');
        return bucket.file(object.name).download({destination: tempLocalFile})

          .then(() => {
            return spawn('convert', [tempLocalFile, '-define', 'jpeg:extent=100kb', tempLocalFile]);
          })

          .then(() =>{
            console.log('Image has been shrunk');

            if(fileNameExtention !== 'jpeg'){
              console.log('update file extention')
              bucket.file(object.name).delete();
              
 
            }
            return bucket.upload(tempLocalFile, {destination: destination})
          })

          .then(() => {     
            const config = {
              action: 'read',
              expires: '01-01-2400'
            }

            return bucket.file(destination).getSignedUrl(config);
          })

          .then(signedUrl =>{
              console.log('Image has been uploaded');
              const fileUrl = signedUrl[0];
              admin.database().ref(dataPath).update({url: fileUrl, name: destinationName, thumbnail: null});
              return
          })
      }
    
    });
  });});


exports.watchBreweryFlag = functions.database.ref('/organization/{placeId}/BREWERY')
    .onWrite(event => {
       const snapshot = event.data;
       const placeId = event.params.placeId;
       return _updateGeoFire(placeId);
    })

exports.watchPubFlag = functions.database.ref('/organization/{placeId}/PUB')
    .onWrite(event => {
       const snapshot = event.data;
       const placeId = event.params.placeId;
       return _updateGeoFire(placeId);
  })

exports.watchPermanentlyClosedFlag = functions.database.ref('/organization/{placeId}/permanently_closed')
    .onWrite(event => {
       const snapshot = event.data;
       const placeId = event.params.placeId;
       return _updateGeoFire(placeId);
  })



exports.setGeoForCrawl = functions.database.ref('/crawl/{crawl_id}')
  .onWrite(event => {
    //TODO change this to onUpdate after updating cli

    if (!event.data.exists()) {
      console.log('item deleted')
      return;
    }
    
    const val = event.data.val(),
          metadata = event.params,
          crawl_id = metadata.crawl_id,
          public = val.public,
          deleted = val.deleted,
          organization = val.organization
    
    if(deleted || !organization){
      return geoCrawl.remove(crawl_id)
        .then(()=>{
          console.log('Removed Geo', metadata)
        })
    }
    admin.database().ref(`/crawl/${crawl_id}/organization`).orderByChild('created').limitToFirst(1)
      .once('value')
      .then(snapshot =>{
        if(!snapshot.exists()){
          return geoCrawl.remove(crawl_id)
            .then(()=>{
              console.log('Removed Geo', metadata)
            })
        }
        return snapshot.forEach(firstPub =>{
          const pub = firstPub.val()

        
        return geoCrawl.set(crawl_id, [firstPub.child('latitude').val(), firstPub.child('longitude').val()])
            .then(()=>{
             console.log('Saved GeoCrawl', metadata)
            })
        })
      })
      .catch(error => {
        console.error('GEO_CRAWL_ERROR', error)
      })})

exports.setPlaceForCrawl = functions.database.ref('/crawl/{crawl_id}/organization/{place_id}')
  .onCreate(event =>{
  const val = event.data.val(),
        created = val.created,
        metadata = event.params,
        crawl_id = metadata.crawl_id,
        place_id = metadata.place_id

  admin.database().ref(`/organization/${place_id}/crawl/${crawl_id}`)
    .update({created: created, crawl_id: crawl_id})
    .then(() =>{
      console.log('Added crawl to org', val)
    })
    .catch(error =>{
      console.error('ERROR', error)
    })})

exports.deletePlaceForCrawl = functions.database.ref('/crawl/{crawl_id}/organization/{place_id}')
  .onDelete(event =>{
  const val = event.data.val(),
        metadata = event.params,
        crawl_id = metadata.crawl_id,
        place_id = metadata.place_id

  admin.database().ref(`/organization/${place_id}/crawl/${crawl_id}`)
    .remove()
    .then(() =>{
      console.log('Removed crawl to org', val)
    })
    .catch(error =>{
      console.error('ERROR', error)
    })})

exports.sanitizeDescription  = functions.database.ref('/organization/{place_id}/description')
  .onWrite(event => {
    const val = event.data.val(),
          metadata = event.params,
          place_id = metadata.place_id,
          profane = swearjar.profane(val),
          censor = swearjar.censor(val)

    if(!event.data.exists()){
      return admin.database().ref(`/organization/${place_id}/description`)
        .remove()
        .then(() =>{
          console.log('removed description')
        })
        .catch(error =>{
          console.error('ERROR', error)
        })
    }

    return admin.database().ref(`/organization/${place_id}/description`)
      .set(censor)
      .then(() =>{
        console.log('saved description')
      })
      .catch(error =>{
        console.error('ERROR', error)
      })
  })

exports.sanitizeMotto  = functions.database.ref('/organization/{place_id}/motto')
  .onWrite(event => {
    const val = event.data.val(),
          metadata = event.params,
          place_id = metadata.place_id,
          profane = swearjar.profane(val),
          censor = swearjar.censor(val)

    if(!event.data.exists()){
      return admin.database().ref(`/organization/${place_id}/motto`)
        .remove()
        .then(() =>{
          console.log('removed motto')
        })
        .catch(error =>{
          console.error('ERROR', error)
        })
   }

    return admin.database().ref(`/organization/${place_id}/motto`)
      .set(censor)
      .then(() =>{
        console.log('saved motto')
      })
      .catch(error =>{
        console.error('ERROR', error)
      })
  })
  
exports.sanitizeCrawlName  = functions.database.ref('/crawl/{crawl_id}/editName')
  .onWrite(event => {
    const val = event.data.val(),
          metadata = event.params,
          crawl_id = metadata.crawl_id,
          profane = swearjar.profane(val),
          censor = swearjar.censor(val)
   
    if(!event.data.exists()){
      return admin.database().ref(`/crawl/${crawl_id}/name`)
        .remove()
        .then(() =>{
          console.log('removed name')
        })
        .catch(error =>{
          console.error('ERROR', error)
        })
    }

    return admin.database().ref(`/crawl/${crawl_id}/name`)
      .set(censor)
      .then(() =>{
        console.log('saved name')
      })
      .catch(error =>{
        console.error('ERROR', error)
      })
  })

exports.sanitizeCrawlDescription  = functions.database.ref('/crawl/{crawl_id}/editDescription')
  .onWrite(event => {
    const val = event.data.val(),
          metadata = event.params,
          crawl_id = metadata.crawl_id,
          profane = swearjar.profane(val),
          censor = swearjar.censor(val)

    if(!event.data.exists()){
      return admin.database().ref(`/crawl/${crawl_id}/description`)
        .remove()
        .then(() =>{
          console.log('removed description')
        })
        .catch(error =>{
          console.error('ERROR', error)
        })
    }

    return admin.database().ref(`/crawl/${crawl_id}/description`)
      .set(censor)
      .then(() =>{
        console.log('saved description')
      })
      .catch(error =>{
        console.error('ERROR', error)
      })
  })

exports.sanitizeMenuName  = functions.database.ref('/organization/{place_id}/menu/{category_id}/editName')
  .onWrite(event => {
    const val = event.data.val(),
          metadata = event.params,
          place_id = metadata.place_id,
          category_id = metadata.category_id,
          profane = swearjar.profane(val),
          censor = swearjar.censor(val)


    if(!event.data.exists()){
      return admin.database().ref(`/organization/${place_id}/menu/${category_id}/name`)
        .remove()
        .then(() =>{
          console.log('removed name')
        })
        .catch(error =>{
          console.error('ERROR', error)
        })
    }

    return admin.database().ref(`/organization/${place_id}/menu/${category_id}/name`)
      .set(censor)
      .then(() =>{
        console.log('saved name')
      })
      .catch(error =>{
        console.error('ERROR', error)
      })
  })

exports.sanitizeMenuDescription  = functions.database.ref('/organization/{place_id}/menu/{category_id}/editDescription')
  .onWrite(event => {
    const val = event.data.val(),
          metadata = event.params,
          place_id = metadata.place_id,
          category_id = metadata.category_id,
          profane = swearjar.profane(val),
          censor = swearjar.censor(val)


    if(!event.data.exists()){
      return admin.database().ref(`/organization/${place_id}/menu/${category_id}/description`)
        .remove()
        .then(() =>{
          console.log('removed description')
        })
        .catch(error =>{
          console.error('ERROR', error)
        })
    }

    return admin.database().ref(`/organization/${place_id}/menu/${category_id}/description`)
      .set(censor)
      .then(() =>{
        console.log('saved description')
      })
      .catch(error =>{
        console.error('ERROR', error)
      })
  })

exports.sanitizeMenuItemName  = functions.database.ref('/organization/{place_id}/menu/{category_id}/item/{item_id}/editName')
  .onWrite(event => {
    const val = event.data.val(),
          metadata = event.params,
          place_id = metadata.place_id,
          category_id = metadata.category_id,
          item_id = metadata.item_id,
          profane = swearjar.profane(val),
          censor = swearjar.censor(val)


    if(!event.data.exists()){
      return admin.database().ref(`/organization/${place_id}/menu/${category_id}/item/${item_id}/name`)
        .remove()
        .then(() =>{
          console.log('removed name')
        })
        .catch(error =>{
          console.error('ERROR', error)
        })
    }

    return admin.database().ref(`/organization/${place_id}/menu/${category_id}/item/${item_id}/name`)
      .set(censor)
      .then(() =>{
        console.log('saved name')
      })
      .catch(error =>{
        console.error('ERROR', error)
      })
  })

exports.sanitizeMenuItemDescription = functions.database.ref('/organization/{place_id}/menu/{category_id}/item/{item_id}/editDescription')
  .onWrite(event => {
    const val = event.data.val(),
          metadata = event.params,
          place_id = metadata.place_id,
          category_id = metadata.category_id,
          item_id = metadata.item_id,
          profane = swearjar.profane(val),
          censor = swearjar.censor(val)


    if(!event.data.exists()){
      return admin.database().ref(`/organization/${place_id}/menu/${category_id}/item/${item_id}/description`)
        .remove()
        .then(() =>{
          console.log('removed description')
        })
        .catch(error =>{
          console.error('ERROR', error)
        })
    }

    return admin.database().ref(`/organization/${place_id}/menu/${category_id}/item/${item_id}/description`)
      .set(censor)
      .then(() =>{
        console.log('saved description')
      })
      .catch(error =>{
        console.error('ERROR', error)
      })
  })

exports.sanitizeMenuPriceItem  = functions.database.ref('/organization/{place_id}/menu/{category_id}/item/{item_id}/price/{price_id}/editSize')
  .onWrite(event => {
    const val = event.data.val(),
          metadata = event.params,
          place_id = metadata.place_id,
          category_id = metadata.category_id,
          item_id = metadata.item_id,
          price_id = metadata.price_id,
          profane = swearjar.profane(val),
          censor = swearjar.censor(val)


    if(!event.data.exists()){
      return admin.database().ref(`/organization/${place_id}/menu/${category_id}/item/${item_id}/price/${price_id}/size`)
        .remove()
        .then(() =>{
          console.log('removed size')
        })
        .catch(error =>{
          console.error('ERROR', error)
        })
    }

    return admin.database().ref(`/organization/${place_id}/menu/${category_id}/item/${item_id}/price/${price_id}/size`)
      .set(censor)
      .then(() =>{
        console.log('saved size')
      })
      .catch(error =>{
        console.error('ERROR', error)
      })
  })



exports.updateFavorite = functions.database.ref('/user/{user_id}/favoriteOrganization/{place_id}')
  .onWrite(event => {
      const snapshot = event.data,
            user_id = event.params.user_id,
            place_id = event.params.place_id;
  
      if(!snapshot.exists()){
        return admin.database().ref(`/organization/${place_id}/favorite/${user_id}`)
        .remove()
        .then(()=>{
          console.log('Removed Favorite')
        })
        .catch(error =>{
          console.error('ERROR_REMOVE', error)
        })
      }

    return admin.database().ref(`/organization/${place_id}/favorite/${user_id}`)
      .update({created:snapshot.child('created').val(), rating:snapshot.child('rating').val()})
      .then(()=>{
        console.log('Updated Favorite')
      })
      .catch(error =>{
        console.error('ERROR_UPDATE', error)
      })
  })

exports.stripeSubscriptionUpdated = functions.https.onRequest((request, response) => {
  // Grab the text parameter.
  const body = request.body,
        event_id = body.id

  stripe.events.retrieve(event_id)
    .then(event =>{
      
      const data = event.data.object,
            type = data.object,
            current_period_end = data.current_period_end,
            metadata = data.metadata
            place_id = metadata.place_id,
            charge_id = metadata.charge_id,
            user_id = metadata.user_id

      return  admin.database().ref(`/user/${user_id}/stripe/organization/${place_id}/charges/${charge_id}`)
        .update(data)
        .then(()=>{
          console.log('data', data)
          response.send('okay')
        })
        .catch(error =>{
          console.error('ERROR_SAVING', error)
          reportError(error, metadata)
          response.send('error')
        })
    })});

exports.getOnTap = functions.https.onRequest((request, response) => {

  if (request.method === 'PUT') {
    response.status(403).send('Forbidden!')
  }

  const query = request.query,
        place_id = query.orgid,
        backgroundColor = (query.backgroundColor) ? query.backgroundColor : 'white',
        primaryColor = (query.primaryColor) ? query.primaryColor : '#303030',
        accentColor = (query.accentColor) ? query.accentColor : '#F07310',
        size = (query.size) ? query.size : 100,
        description = (query.description) ? true : false,
        abv = (query.abv) ? true : false,
        json = (query.json) ? true : false,
        logo = `<div style="display:flex;justify-content:center;text-decoration:none;margin:20px 0"><a href="https://www.beer-fly.com/brewery/main?orgid=${place_id}"><div style="margin-top:3px;float:left;font-size:${size*.01}em;font-weight:500;color:${primaryColor}">Powered by Beer-Fly</div><img style="margin-left:5px" src="https://www.beer-fly.com/images/beer-icon-22.png"></a></div>`


  let html = ''

  admin.database().ref(`/organization/${place_id}/plan/current_period_end`)
    .once('value')
    .then(snapshot =>{
      if(!snapshot.exists()){
        return response.status(401).send('Unauthorized: Must have a current plan')
      }
      if(snapshot.val()*1000 < Date.now()){
        return response.status(401).send('Unauthorized: Must have a current plan')
      }
      return place_id
    })
    .then(place_id =>{
      admin.database().ref(`/organization/${place_id}/onTap`).orderByChild('order')
        .once('value')
        .then(snapshot =>{
          if(!snapshot.exists()){
            return response.status(200).send('No data')
          }

          if(json){
            return response.status(200).send(JSON.stringify(snapshot.val()))
          }

          snapshot.forEach(beer =>{
            // console.log(beer.val());
            if(beer.child('name').exists() && beer.child('tapped').val() ==='TAPPED'){

              html += `<div style="margin-top:${size*.3}px;font-size:${size*.015}em;font-weight:300;color:${primaryColor}"'>${beer.child('name').val()}</div>`

              if(beer.child('styleName').exists()){
                html += `<div style="margin-top:${size*.1}px;font-size:${size*.012}em;font-weight:500;color:${accentColor}">${beer.child('styleName').val()}</div>`
              }

              if(beer.child('breweryName').exists()){
                html += `<div style="margin-top:${size*.1}px;font-size:${size*.01}em;font-weight:300;color:${primaryColor}">${beer.child('breweryName').val()}</div>`
              }

              if(beer.child('city').exists() && beer.child('state').exists()){
                html += `<div style="margin-top:${size*.025}px;font-size:${size*.008}em;font-weight:300;color:${primaryColor}">${beer.child('city').val()}, ${beer.child('state').val()}</div>`
              }

              if(beer.child('description').exists() && description){
                html += `<div style="margin-top:${size*.125}px;font-size:${size*.01}em;font-weight:300;color:${primaryColor}">${beer.child('description').val()}</div>`
              }

              if(beer.child('abv').exists() && abv){
                html += `<div style="margin-top:${size*.1}px;font-size:${size*.01}em;font-weight:300;color:${primaryColor}">ABV: ${beer.child('abv').val()}</div>`
              }
            }
          })
          
          return response.status(200).send(`<!DOCTYPE html><html><body style="font-family:'Roboto','Noto',sans-serif;background-color:${backgroundColor}">${html}${logo}</body></html>`)

          })

        })
       })

exports.getBeers = functions.https.onRequest((request, response) => {

  if (request.method === 'PUT') {
    response.status(403).send('Forbidden!')
  }

  const query = request.query,
        place_id = query.orgid,
        backgroundColor = (query.backgroundColor) ? query.backgroundColor : 'white',
        primaryColor = (query.primaryColor) ? query.primaryColor : '#303030',
        accentColor = (query.accentColor) ? query.accentColor : '#F07310',
        size = (query.size) ? query.size : 100,
        description = (query.description) ? true : false,
        abv = (query.abv) ? true : false,
        json = (query.json) ? true : false,
        logo = `<div style="display:flex;justify-content:center;text-decoration:none;margin:20px 0"><a href="https://www.beer-fly.com/brewery/main?orgid=${place_id}"><div style="margin-top:3px;float:left;font-size:${size*.01}em;font-weight:500;color:${primaryColor}">Powered by Beer-Fly</div><img style="margin-left:5px" src="https://www.beer-fly.com/images/beer-icon-22.png"></a></div>`


  let html = ''

  admin.database().ref(`/organization/${place_id}/plan/current_period_end`)
    .once('value')
    .then(snapshot =>{
      if(!snapshot.exists()){
        return response.status(401).send('Unauthorized: Must have a current plan')
      }
      if(snapshot.val()*1000 < Date.now()){
        return response.status(401).send('Unauthorized: Must have a current plan')
      }
      return place_id
    })
    .then(place_id =>{
      admin.database().ref(`/organization/${place_id}/brewBeer`).orderByChild('order')
        .once('value')
        .then(snapshot =>{
          if(!snapshot.exists()){
            return response.status(200).send('No data')
          }

          if(json){
            return response.status(200).send(JSON.stringify(snapshot.val()))
          }

          snapshot.forEach(beer =>{
            // console.log(beer.val());
            if(beer.child('name').exists() && beer.child('status').val() ==='verified'){
              html += `<div style="margin-top:${size*.3}px;font-size:${size*.015}em;font-weight:300;color:${primaryColor}"'>${beer.child('name').val()}</div>`
              if(beer.child('styleName').exists()){
                html += `<div style="margin-top:${size*.1}px;font-size:${size*.012}em;font-weight:500;color:${accentColor}">${beer.child('styleName').val()}</div>`
              }
              if(beer.child('description').exists() && description){
                html += `<div style="margin-top:${size*.1}px;font-size:${size*.01}em;font-weight:300;color:${primaryColor}">${beer.child('description').val()}</div>`
              }
              if(beer.child('abv').exists() && abv){
                html += `<div style="margin-top:${size*.1}px;font-size:${size*.01}em;font-weight:300;color:${primaryColor}">ABV: ${beer.child('abv').val()}</div>`
              }
            }
          })
          
          return response.status(200).send(`<!DOCTYPE html><html><body style="font-family:'Roboto','Noto',sans-serif;background-color:${backgroundColor}">${html}${logo}</body></html>`)

          })

        })
       

  })
    
exports.updateFavoriteBeer = functions.database.ref('/user/{user_id}/favoriteBeer/{beer_id}')
  .onWrite(event => {
      const snapshot = event.data;
      const user_id = event.params.user_id;
      const beer_id = event.params.beer_id;
  console.log(`/beer/${beer_id}/rating/${user_id}`)
  if(!snapshot.exists()){
    return admin.database().ref(`/beer/${beer_id}/rating/${user_id}`)
    .remove()
    .then(()=>{
      console.log('Removed Favorite Beer')
    })
    .catch(error =>{
      console.error('ERROR_REMOVE_FAV_BEER', error)
    })
  }

  return admin.database().ref(`/beer/${beer_id}/rating/${user_id}`)
    .update({
            created:snapshot.child('created').val(), 
            favorite:snapshot.child('favorite').val(), 
            rating:snapshot.child('rating').val()
          })
    .then(()=>{
      console.log('Updated Favorite')
    })
    .catch(error =>{
      console.error('ERROR_UPDATE', error)
    })})

function _updateGeoFire(placeId){

   admin.database().ref(`/organization/${placeId}`)
        .once('value')
        .then(snapshot =>{
          const pub = snapshot.val();
          
          if(pub.permanently_closed){
             return geoFire.remove(pub.place_id)
              .then(() =>{
                console.log('removed from geo');
                return
              })
              .catch(error =>{
                console.log('GEO_REMOVE_ERROR', error);
                return
              })
          }

          if(pub.BREWERY || pub.PUB){

            console.log('add to geo');
            return geoFire.set(pub.place_id, [pub.latitude, pub.longitude])
              .then(data => {
                console.log("Set GeoFire", pub);
                return
              })
              .catch(error=>{
                console.log("GEO_FIRE_SET_ERROR: " + error);
                return
              }) 

          }else{

            return geoFire.remove(pub.place_id)
            .then(() =>{
              console.log('removed from geo');
              return
            })
            .catch(error =>{
              console.log('GEO_REMOVE_ERROR', error);
              return
            })
          }
      })
}

// function updateBeer (beerId, beerData, pubData) {
//   let saveObj = {};
//   let beerItems = ['abv', 'beerId', 'breweryName', 
//                    'category', 'categoryName', 'categoryTitle', 
//                    'createDate', 'description', 'id', 'name', 
//                    'order', 'status', 'styleId', 'styleName', 'updateDate']

//   for (var i=0; i<beerItems.length; i++){
//     let item = beerItems[i];
//     if(beerData[item]){
//       saveObj[item] = beerData[item];
//     }
//   }

//   let pubItems = ['city', 'domain', 'latitude', 'location',
//                   'longitude', 'state', 'stateAbbreviation']

//   for (var i=0; i<pubItems.length; i++){
//     let pubItem = pubItems[i];
//     if(pubData[pubItem]){
//       saveObj[pubItem] = pubData[pubItem];
//     }
//   }

//   if(pubData.stateAbbreviation && beerData.category){
//     saveObj['stateAndCategory'] = pubData.stateAbbreviation+'_'+beerData.category
//   }

//   if(pubData.stateAbbreviation && beerData.styleId){
//     saveObj['stateAndStyleId'] = pubData.stateAbbreviation+'_'+beerData.styleId
//   }

//   if(pubData.place_id){
//     saveObj['location/'+pubData.place_id] = true;
//   }

//   if(pubData.place_id){
//     saveObj['place_id'] = pubData.place_id;
//   }

//   // console.log('saving beer', saveObj);
//   admin.database().ref('beer').child(beerId)
//     .update(saveObj)
//     .catch( function (error){
//       console.log('SAVE_ERROR', error)
//     }).then(function (){
//       console.log('SAVED_BEER');
//     })
//   }

 
function parseGooglePlaceData (place){

  const newPlace = {},
        metaItems = ['name','place_id', 'formatted_address', 'vicinity', 'formatted_phone_number']
  
    if(place.permanently_closed){
      newPlace['permanently_closed'] = true
    }

    for (let value of metaItems) {
      if(place[value]){
        newPlace[value] = place[value]
      }
    }

    if(place.geometry){
      if(place.geometry.location){
        if(place.geometry.location.lat){
            newPlace['latitude'] = place.geometry.location.lat
        }
        if(place.geometry.location.lng){
            newPlace['longitude'] = place.geometry.location.lng
        }
      }
    }

    if(place.website){
      let domain = getDomain(place.website)
      newPlace['website'] = place.website
      newPlace['domain'] = domain
    }

    if(place.address_components){
        var placeAddress = getAddressObject(place.address_components);
        if(placeAddress){
            var placeAddressKey = Object.keys(placeAddress)
            for (let value of placeAddressKey){
                newPlace[value] = placeAddress[value]
            }
        }
    }
  return newPlace
}

  

  // function updateAllBeerData(beerId, placeId, beerData){
  //   admin.database().ref('organization').child(placeId)
  //     .once('value').then(function (snapshot){
  //       return snapshot.val();
  //     }).then(function (pub){
  //       if(pub.domain){
  //         var returnObj = {};

  //          updateBeer(beerId, beerData, pub);

  //             admin.database().ref('organization')
  //               .orderByChild('domain').equalTo(pub.domain).limitToFirst(100)  
  //                 .once("value")
  //                   .then(function(snapshot) {
  //                     snapshot.forEach(function(childSnapshot) {
  //                       var place_id = childSnapshot.key;
  //                       var changePub = childSnapshot.val();
  //                       if(!changePub.beerLastUpdated){
  //                         changePub.beerLastUpdated = 0;
  //                       }
  //                       if(place_id === placeId){
  //                         console.log('already changed', changePub);
  //                         return 
  //                       }else{
  //                         if(changePub.beerLastUpdated >= pub.beerLastUpdated){
  //                           console.log('already updated');

  //                         }else{
  //                           console.log('needs to be updated');
  //                           returnObj[changePub.place_id+'/beerLastUpdated'] = pub.beerLastUpdated;
  //                           returnObj[changePub.place_id+'/brewBeer'] = pub.brewBeer;
  //                         }      
  //                       }
  //                     })
                      
  //                     return returnObj;
  //                 }).then(function (saveObj){
  //                   console.log('save beer at other locations', saveObj)
  //                   if(Object.keys(saveObj).length >0){
  //                     admin.database().ref('organization').update(saveObj)
  //                     .catch( function (error){
  //                       console.log('SAVE_ERROR', error)
  //                     }).then(function (){
  //                       console.log('SAVED');
  //                     })
  //                   }
  //                 })
                 
  //       }
  //     })
  // }


  function setGeoData(data, placeId, beerId){
    if(data.latitude){
      if(data.longitude){
        const geoTapRef = admin.database().ref('GeoTap/'+beerId);
        const geoTapFire = new GeoFire(geoTapRef);
        geoTapFire.set(placeId, [data.latitude, data.longitude]).then(function() {
          console.log("Set GeoTapFire");
          }, function(error) {
              console.error("GeoTapFireError: " + error);
          });

      }
    }
  }

  function removeGeoData(placeId, beerId){
  
    const geoTapRef = admin.database().ref('GeoTap/'+beerId);
    const geoTapFire = new GeoFire(geoTapRef);
    geoTapFire.remove(placeId)
      .then(function() {
        console.log("Remove GeoTapFire");
      }, function(error) {
          console.error("GeoTapFireError: " + error);
      });
  }



function getDomain(website){
  if(website){
    var ignore = ['wordpress', 'facebook']
    var domainSide = website.split('//')[1];
    var domainArray = domainSide.split('/')[0];
    var domain = domainArray.replace('www.','');
    for(var i=0; i<ignore.length; i++){
      
      if(domain.indexOf(ignore[i]) !== -1){
        return null;
      } 
    }
    return domain;
  }else{
    return null;
  }
}


function getAddressObject(address){
  var obj = {};
  let street = '';
  let route = '';
    for (var i=0; i<address.length; i++){
      if(address[i].types){   
        for (var j=0; j<address[i].types.length; j++){
          var type = address[i].types[j];
          if(type === 'route'){
            route = address[i].short_name;
          }
          if(type === 'street_number'){
            street = address[i].long_name;
          }
          
          if(type === 'postal_code'){
            obj.zipcode = address[i].long_name;
          }
          if(type === 'administrative_area_level_1'){
            obj.state = address[i].long_name;
            obj.stateAbbreviation = address[i].short_name;
          }
          if(type === 'locality'){
            obj.city = address[i].long_name;
          }
          if(type === 'country'){
            obj.country = address[i].long_name;
            obj.countryAbbreviation = address[i].short_name;
          }
        }
      }
    }
    obj.address = street+' '+route;
    return obj;
}




function reportError(err, context = {}) {

  const logName = 'errors';
  const log = logging.log(logName);

  const metadata = {
    resource: {
      type: 'cloud_function',
      labels: { function_name: process.env.FUNCTION_NAME }
    }
  };

  const errorEvent = {
    message: err.stack,
    serviceContext: {
      service: process.env.FUNCTION_NAME,
      resourceType: 'cloud_function'
    },
    context: context
  };

  // Write the error log entry
  return new Promise((resolve, reject) => {
    log.write(log.entry(metadata, errorEvent), error => {
      if (error) { reject(error); }
      resolve();
    });
  });
}
// [END reporterror]

// Sanitize the error message for the user
function userFacingMessage(error) {
  return error.type ? error.message : 'An error occurred, developers have been alerted';
}


// exports.beerDataChanged = functions.database.ref('organization/{place_id}/brewBeer/{beer_id}')
//   .onWrite(event => {
//     const snapshot = event.data,
//           root = snapshot.ref.root,
//           place_id = event.params.place_id,
//           beer_id = event.params.beer_id,
//           data = snapshot.val(),
//           name = data.name,
//           description = data.description,
//           saveObj = {},
//           styleData = root.child(`category/STYLE/${snapshot.child('styleId').val()}`).once('value'),
//           orgData = root.child(`organization/${place_id}`).once('value'),
//           beerDB = root.child(`beer/${beer_id}`),
//           location = root.child(`beer/${beer_id}/location/${place_id}`),
//           styleItems = ['category', 'categoryName', 'categoryTitle', 'styleName', 'order']
//           beerItems = ['abv', 'beerId', 'breweryName', 
//                       'createDate', 'description', 'id', 'name', 
//                       'status', 'styleId', 'updateDate'],
//           orgItems = ['city', 'domain', 'latitude', 'location',
//                       'longitude', 'state', 'stateAbbreviation','place_id']


//       if(!snapshot.exists()){
//         console.log('beer data deleted');
//         return 
//       }

//       if(snapshot.child('name').changed() || snapshot.child('description').changed() || snapshot.child('styleId').changed()){

//         if(swearjar.profane(name)){
//           saveObj.name = swearjar.censor(name)
//         }

//         if(swearjar.profane(description)){
//           saveObj.description = swearjar.censor(description)
//         }

//         return Promise.all([styleData, orgData])

//         .then(results =>{
//           const styleValue = results[0].val(),
//                 orgValue = results[1].val()

//           for (let item of styleItems){
//             saveObj[item] = (styleValue[item]) ? styleValue[item] : null
//           }
          
//           snapshot.adminRef.update(Object.assign({}, saveObj))
//           return orgValue
//         })
//         .then(orgValue =>{

//           for (let item of orgItems){
//             saveObj[item] = (orgValue[item]) ? orgValue[item] : null
//           }

//           for (let item of beerItems){
//             saveObj[item] = (data[item]) ? data[item] : null
//           }

//           if(saveObj.stateAbbreviation && saveObj.category){
//             saveObj['stateAndCategory'] = `${saveObj.stateAbbreviation}_${saveObj.category}`
//           }

//           if(saveObj.stateAbbreviation && saveObj.styleId){
//             saveObj['stateAndStyleId'] = `${saveObj.stateAbbreviation}_${saveObj.styleId}`
//           }

//         return beerDB.update(saveObj)
                
//         })
//         .then(()=>{
//           return  location.set(true)
//         })
//         .then(()=>{
//           console.log('updated beer data')
//           return;
//         })
//         .catch(error =>{
//           console.error(error)
//         })
                 
//       }
    
   
        

//   });
  

