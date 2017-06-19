const functions = require('firebase-functions');
const admin = require('firebase-admin');
const GeoFire = require('geofire');

const gcs = require('@google-cloud/storage')({keyFilename:'serviceAccountKey.json'});
const vision = require('@google-cloud/vision')();
const exec = require('child-process-promise').exec;
const spawn = require('child-process-promise').spawn;

const  fs = require('fs');

admin.initializeApp(functions.config().firebase);

const googleMapsClient = require('@google/maps')
    .createClient({
        key: 'AIzaSyBPa6XlVFjF48fEyNT3qtnkFTZ0_dGMAzI'
      });

const geoRef = admin.database().ref('GeoFire');
const geoFire = new GeoFire(geoRef);


exports.createNewUser = functions.auth.user().onCreate(function(event) {
  
  
  var data = event.data;
  var uid = data.uid;
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

   admin.database().ref('user').child(uid)
    .update(obj)
    .catch( function (error){
      console.log('SAVE_ERROR', error)
    }).then(function (){
      console.log('SAVED_INITIAL_USER');
    })

  return 
});



exports.saveNewPub = functions.database.ref('/newOrg/{placeId}/{domain}')
    .onWrite(event => {

      const data = event.data;
      const placeId = event.params.placeId;
      const domain = event.params.domain;
  
      if (!event.data.exists()) {
        console.log('item deleted')
        return;
      }

      return googleMapsClient.place({placeid: placeId}, 
        function(error, response) {
            if (!error) {
       
              let newPub = {}; 
              let place = response.json.result;
              let preOrg = 'organization/'+place.place_id+'/';
              let brewery = false;
              let pub = false;
              let truck = false;
              let domain;

              console.log('received place data', place);
            
              if(place.permanently_closed){
                newPub[preOrg+'permanently_closed'] = true; 
              }

              if(place.types){
                if (!event.data.previous.exists()) {
                  if(isPub(place.types)){
                      newPub[preOrg+'PUB'] = true;
                      pub = true;
                  }
                }
              }

              if(place.name){

                newPub[preOrg+'/name'] = place.name;

                if (!event.data.previous.exists()) {


                  if(place.name.toLowerCase().indexOf('brewing')>-1){
                    newPub[preOrg+'BREWERY'] = true;
                    brewery = true;
                  }

                  if(place.name.toLowerCase().indexOf('brewery')>-1){
                    newPub[preOrg+'BREWERY'] = true;
                    brewery = true;
                  }

                  if(place.name.toLowerCase().indexOf('truck')>-1){
                    newPub[preOrg+'TRUCK'] = true;
                    truck = true;
                  }
                }

              }
              

              if(place.geometry){
                if(place.geometry.location){
                  if(place.geometry.location.lat){
                      newPub[preOrg+'latitude'] = place.geometry.location.lat
                  }
                  if(place.geometry.location.lng){
                      newPub[preOrg+'longitude'] = place.geometry.location.lng
                  }
                }
              }

            let metaItems = ['place_id', 'formatted_address', 'vicinity', 'formatted_phone_number']

            for (let value of metaItems) {
              if(place[value]){
                newPub[preOrg+value] = place[value];
              }
            }
            

            if(place.website){
                domain = getDomain(place.website);
                newPub[preOrg+'website'] = place.website;
                newPub[preOrg+'domain'] = domain;
                newPub['newOrg/'+place.place_id+'/domain'] = domain;
            }


            if(place.address_components){
                var placeAddress = getAddressObject(place.address_components);
                if(placeAddress){
                    var placeAddressKey = Object.keys(placeAddress);
                    for (let value of placeAddressKey){
                        newPub[preOrg+value] = placeAddress[value];
                    }
                }
            }

            if (!event.data.previous.exists()) {
              newPub[preOrg+'/category'] = _getBaseCategories();
            }

            console.log('created pub data', newPub);
            console.log('domain', domain);

            //look for other locations
            if(domain){
              admin.database().ref('organization')
                .orderByChild('domain').equalTo(domain).limitToFirst(1)  
                  .once("value")
                    .then(snapshot => {

                      console.log('other location', snapshot.val());

                      if (snapshot.exists()){
                        
                        if (!event.data.previous.exists()){
                        
                          var snapshot = snapshot.val();

                          
                          var key = Object.keys(snapshot);
                          var data = snapshot[key[0]];

                          var locationItems = ['breweryName', 'description', 'motto', 'mainImage', 'beerLastUpdated']
                          for(let locationKey of locationItems)

                          if(data[locationKey]){
                            newPub[preOrg+locationKey] = data[locationKey];
                          }
    
                          if(data.brewBeer){
                            newPub[preOrg+'brewBeer'] = data.brewBeer;
                            newPub[preOrg+'category/BEER/display'] = true;
                          }
                        }
                      }
                          
                      return newPub;
                    
                    })
                    .then(newPub =>{
                     
                      if(!place.permanently_closed){
                        if(brewery|| pub){
                          // if(place.geometry){
                          //     geoFire.set(place.place_id, [place.geometry.location.lat, place.geometry.location.lng])
                          //       .then(data => {
                          //         console.log("Set GeoFire", data);
                          //       })
                          //       .catch(error=>{
                          //         console.log("Error: " + error);
                          //       }) 
                          //     }  
                          }  
                        }
                         console.log('save new pub', newPub);

                      admin.database().ref().update(newPub)
                        .then(saved =>{
                          console.log('saved data')
                        })
                        .catch( error =>{
                          console.log('ERROR_SAVING_DATA', error)
                        })
                    })
              
              }
            }
        })   

  
});



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



exports.beerDataChanged = functions.database.ref('organization/{placeId}/brewBeer/{beerId}')
  .onWrite(event => {
    const snapshot = event.data;
    const placeId = event.params.placeId;
    const beerId = event.params.beerId;
    const data = snapshot.val();

    console.log('beerId', beerId);
    console.log('placeId', placeId);
    console.log('beer-data', data);
   
      
    if(event.data.previous.exists()){
      if(!event.data.exists()){
        console.log('beer data deleted');
        return 

      }else{
        
        if(event.data.changed()){
          console.log('beer data changed');
          updateBeer(beerId, placeId, data);

          //don't update ontap beers
          // updateOnTap();

          return updateAllBeerData(beerId, placeId, data);
        }else{
          console.log('beer data unchanged')
          return;
        }
      }

    }else{
      console.log('beer data added');
      updateBeer(beerId, placeId, data);
      return updateAllBeerData(beerId, placeId, data);
    }

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
      

      return;
 
});

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
      

      return;
 
  
});


  
  function updateBeer (beerId, beerData, pubData) {
  let saveObj = {};
  let beerItems = ['abv', 'beerId', 'breweryName', 
                   'category', 'categoryName', 'categoryTitle', 
                   'createDate', 'description', 'id', 'name', 
                   'order', 'status', 'styleId', 'styleName', 'updateDate']

  for (var i=0; i<beerItems.length; i++){
    let item = beerItems[i];
    if(beerData[item]){
      saveObj[item] = beerData[item];
    }
  }

  let pubItems = ['city', 'domain', 'latitude', 'location',
                  'longitude', 'state', 'stateAbbreviation']

  for (var i=0; i<pubItems.length; i++){
    let pubItem = pubItems[i];
    if(pubData[pubItem]){
      saveObj[pubItem] = pubData[pubItem];
    }
  }

  if(pubData.stateAbbreviation && beerData.category){
    saveObj['stateAndCategory'] = pubData.stateAbbreviation+'_'+beerData.category
  }

  if(pubData.stateAbbreviation && beerData.styleId){
    saveObj['stateAndStyleId'] = pubData.stateAbbreviation+'_'+beerData.styleId
  }

  if(pubData.place_id){
    saveObj['location/'+pubData.place_id] = true;
  }

  if(pubData.place_id){
    saveObj['place_id'] = pubData.place_id;
  }

  // console.log('saving beer', saveObj);
  admin.database().ref('beer').child(beerId)
    .update(saveObj)
    .catch( function (error){
      console.log('SAVE_ERROR', error)
    }).then(function (){
      console.log('SAVED_BEER');
    })
  }

  function updateAllBeerData(beerId, placeId, beerData){
    admin.database().ref('organization').child(placeId)
      .once('value').then(function (snapshot){
        return snapshot.val();
      }).then(function (pub){
        if(pub.domain){
          var returnObj = {};

           updateBeer(beerId, beerData, pub);

              admin.database().ref('organization')
                .orderByChild('domain').equalTo(pub.domain).limitToFirst(100)  
                  .once("value")
                    .then(function(snapshot) {
                      snapshot.forEach(function(childSnapshot) {
                        var place_id = childSnapshot.key;
                        var changePub = childSnapshot.val();
                        if(!changePub.beerLastUpdated){
                          changePub.beerLastUpdated = 0;
                        }
                        if(place_id === placeId){
                          console.log('already changed', changePub);
                          return 
                        }else{
                          if(changePub.beerLastUpdated >= pub.beerLastUpdated){
                            console.log('already updated');

                          }else{
                            console.log('needs to be updated');
                            returnObj[changePub.place_id+'/beerLastUpdated'] = pub.beerLastUpdated;
                            returnObj[changePub.place_id+'/brewBeer'] = pub.brewBeer;
                          }      
                        }
                      })
                      
                      return returnObj;
                  }).then(function (saveObj){
                    console.log('save beer at other locations', saveObj)
                    if(Object.keys(saveObj).length >0){
                      admin.database().ref('organization').update(saveObj)
                      .catch( function (error){
                        console.log('SAVE_ERROR', error)
                      }).then(function (){
                        console.log('SAVED');
                      })
                    }
                  })
                 

        }
      })
  }


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
  });
});


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



