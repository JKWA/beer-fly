const functions = require('firebase-functions');
const admin = require('firebase-admin');
const GeoFire = require('geofire');
const gcs = require('@google-cloud/storage')();
const vision = require('@google-cloud/vision')();
const exec = require('child-process-promise').exec;
const  fs = require('fs');

admin.initializeApp(functions.config().firebase);

const googleMapsClient = require('@google/maps')
    .createClient({
        key: 'AIzaSyBPa6XlVFjF48fEyNT3qtnkFTZ0_dGMAzI'
      });

const geoRef = admin.database().ref('GeoFire');
const geoFire = new GeoFire(geoRef);


exports.saveNewPub = functions.database.ref('/newOrg/{place_id}')
    .onWrite(event => {
      // Only edit data when it is first created.
      if (event.data.previous.exists()) {
        console.log('data exists')
        return;
      }
      // Exit when the data is deleted.
      if (!event.data.exists()) {
        console.log('item deleted')
        return;
      }
      const snapshot = event.data;
     

      return getGoogleData(snapshot.key);
 
  
});

exports.updateTapGeoData = functions.database.ref('organization/{placeId}/onTap/{beerId}')
  .onWrite(event => {
    const snapshot = event.data;
    const placeId = event.params.placeId;
    const beerId = event.params.beerId;
    const data = snapshot.val();

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
 
    console.log('beerId', beerId);
    console.log('placeId', placeId);

    
    console.log('tap-data', data);
    return setGeoData(data, placeId, beerId);

  })

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
    geoTapFire.remove(placeId).then(function() {
      console.log("Remove GeoTapFire");
      }, function(error) {
          console.error("GeoTapFireError: " + error);
      });
  }



 function getGoogleData(place_id){  
    try{

        let newPub = {};  
        googleMapsClient.place({
            placeid: place_id
        }, function(err, response) {
            if (!err) {

              var place = response.json.result;
              var preOrg = 'organization/'+place.place_id+'/';
            
              if(place.permanently_closed){
                newPub[preOrg+'permanently_closed'] = true; 
              }

              if(place.types){
                if(isPub(place.types)){
                    newPub[preOrg+'PUB'] = true;
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

            if(place.name){
                newPub[preOrg+'name'] = place.name;
            }

            if(place.place_id){
                newPub[preOrg+'place_id'] = place.place_id;
            }

            if(place.formatted_address){
                newPub[preOrg+'formatted_address'] = place.formatted_address;
            }

            if(place.formatted_phone_number){
                newPub[preOrg+'formatted_phone_number'] = place.formatted_phone_number;
            }

            if(place.vicinity){
                newPub[preOrg+'vicinity'] = place.vicinity;
            }

            if(place.website){
                newPub[preOrg+'website'] = place.website;
                newPub[preOrg+'domain'] = getDomain(place.website);
            }

            if(place.address_components){
                var placeAddress = getAddressObject(place.address_components);
                if(placeAddress){
                    var placeAddressKey = Object.keys(placeAddress);
                    for (var i=0; i<placeAddressKey.length; i++){
                        newPub[preOrg+placeAddressKey[i]] = placeAddress[placeAddressKey[i]];
                    }
                }
            }
            newPub[preOrg+'crowdSource'] = true;

            var category = getBaseCategories()
              var categoryKey = Object.keys(category);
              for (var i=0; i<categoryKey.length; i++){
                var categoryObj = category[categoryKey[i]];
                var subCatKey = Object.keys(categoryObj);
                for (var j=0; j<subCatKey.length; j++){
                  newPub[preOrg+'category/'+categoryKey[i]+'/'+subCatKey[j]] = category[categoryKey[i]][subCatKey[j]];
                }
              }

            savePub(newPub, place);

            }else{
            console.log(err);
            }
        });
    }catch (error){
      console.log('PLACE_ERROR', error);
    }
  }

function isPub(types){ 
  if(types){
    for (var i=0; i<types.length; i++){
      if(types[i] === 'bar'){
        return true;
      }
    }
  }
  return false;
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

function getBaseCategories(){
    var category = {};
    category['BEER'] = {};
    category['BEER'].display = false;
    category['BEER'].name = 'beer';
    category['BEER'].order = 200;
    category['BEER'].title = 'Our beers';

    category['MENU'] = {};
    category['MENU'].display = false;
    category['MENU'].name = 'menu';
    category['MENU'].order = 300;
    category['MENU'].title = 'Menu';

    category['CONTACT'] = {};
    category['CONTACT'].display = true;
    category['CONTACT'].name = 'contact';
    category['CONTACT'].order = 500;
    category['CONTACT'].title = 'Contact';

    category['REVIEW'] = {};
    category['REVIEW'].display = true;
    category['REVIEW'].name = 'review';
    category['REVIEW'].order = 900;
    category['REVIEW'].title = 'Reviews';

    category['TAP'] = {};
    category['TAP'].display = true;
    category['TAP'].name = 'tap';
    category['TAP'].order = 100;
    category['TAP'].title = 'On tap';

    return category;

}

function savePub(pub, place){
  if(place.place_id){

    pub['newOrg/'+place.place_id+'/timestamp'] = Date.now();

    if(!place.permanently_closed){
       if(place.geometry){
         geoFire.set(place.place_id, [place.geometry.location.lat, place.geometry.location.lng]).then(function() {
          console.log("Set GeoFire", place);
          }, function(error) {
              console.log("Error: " + error);
          });
       }    
    }
    console.log('save', pub);
    return admin.database().ref().update(pub);
  }
}


exports.processImage = functions.storage.object().onChange(event => {
  const object = event.data;
  // Exit if this is a deletion or a deploy event.
  if (object.resourceState === 'not_exists') {
    return console.log('This is a deletion event.');
  } else if (!object.name) {
    return console.log('This is a deploy event.');
  }

  const bucket = gcs.bucket(object.bucket);
  const file = bucket.file(object.name);
  console.log(event.data);

  // Check the image content using the Cloud Vision API.
  return vision.detectSafeSearch(file).then(safeSearchResult => {
    if (safeSearchResult[0].adult || safeSearchResult[0].violence) {
      console.log('The image', object.name, 'has been detected as inappropriate.');
      
      return deleteImage(object.name, bucket, object);
    } else {
      console.log('The image', object.name,'has been detected as OK.');
      console.log('size', object.size);
      if(object.size <= 120000){
        console.log('Size okay');
        return base64(object.name, bucket, object);
      }else{
        console.log('Size too large');
        return shrinkImage(object.name, bucket, object);
      }
    }
  });
});

function deleteImage(filePath, bucket, metadata){
  const fileArray = filePath.split('/');
  // const encodedPath = 'https://firebasestorage.googleapis.com/v0/b/beer-fly.appspot.com/o/'+fileArray.join('%2F')+'?alt=media';
  const fileName = fileArray.pop();
  // fileArray.pop();
  // const messageId = filePath.split('/')[1];
  const dataPath = fileArray.join('/');
  
  return bucket.file(filePath).delete()
    .then(() => {
      console.log('Image has been deleted');
      console.log(dataPath);
      admin.database().ref(dataPath).remove();
    })
}





function shrinkImage(filePath, bucket, metadata) {
  let fileArray = filePath.split('/');
  const encodedPath = 'https://firebasestorage.googleapis.com/v0/b/beer-fly.appspot.com/o/'+fileArray.join('%2F')+'?alt=media';
  const fileName = fileArray.pop();
  const tempLocalFile = `/tmp/${fileName}`;

  const dataPath = fileArray.join('/');


  return bucket.file(filePath).download({destination: tempLocalFile})
    .then(() => {
     
      console.log('Image has been downloaded to', tempLocalFile);

      return exec(`convert ${tempLocalFile} -define jpeg:extent=100kb ${tempLocalFile}`);
    }).then(() => {
      console.log('Image has been shrunk');
      
      return bucket.upload(tempLocalFile, {destination: filePath});
    }).then(() => {
      console.log('Image has been saved');

      // return exec(`convert ${tempLocalFile} -quality   1% ${tempLocalFile}`);
      return true
  
    }).then(() => {
     
      
    });
}



function base64(filePath, bucket, metadata) {
  let fileArray = filePath.split('/');
  const encodedPath = 'https://firebasestorage.googleapis.com/v0/b/beer-fly.appspot.com/o/'+fileArray.join('%2F')+'?alt=media';
  const fileName = fileArray.pop();
  const tempLocalFile = `/tmp/${fileName}`;

  const dataPath = fileArray.join('/');


  return bucket.file(filePath).download({destination: tempLocalFile})
    .then(() => {
     
      console.log('Image has been downloaded to', tempLocalFile);

      // return exec(`convert ${tempLocalFile} -strip -channel RGBA -blur 0x24 -quality 3 -resample 150 ${tempLocalFile}`);
      return exec(`convert ${tempLocalFile} -strip -thumbnail 100x100 ${tempLocalFile}`);

    }).then(() => {

      console.log('Image has been shrunk alot ');

     
      fs.readFile(tempLocalFile, 'base64', function (err,data) {
        if (err) {
          return console.log(err);
        }else{
          console.log(data);
          return admin.database().ref(dataPath).update({thumbnail: data});
        }
      });
     
      
    }).then((file) => {
      console.log('Base 64 image has been saved');
    })
}
